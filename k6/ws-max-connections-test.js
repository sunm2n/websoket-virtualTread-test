/**
 * k6 WebSocket 최대 동시 연결 한계 테스트
 *
 * 목적: WebSocket 연결을 단계적으로 늘려 최대 동시 연결 한계점을 탐색하고,
 *       Platform Thread vs Virtual Thread의 수용 능력 차이를 수치화한다.
 *
 * 기존 ws-stomp-test.js 대비 차이점:
 *   - VU 단계: 1,000 → 2,000 → 3,000 → 5,000 (기존: 최대 1,000)
 *   - 연결 유지: 2초 간격 메시지 전송으로 hold 구간 동안 연결 유지 (기존: 20개 메시지 후 종료)
 *   - timeout: 60초 (기존: 30초)
 *   - threshold 없음 — 한계 탐색이 목적이므로 에러 발생을 허용
 *
 * 실행 전 준비:
 *   1. ulimit -n 확인 및 상향 (최소 10,000)
 *      ulimit -n 10240
 *   2. 서버 실행 (VT OFF 먼저, 이후 VT ON으로 재실행)
 *
 * 실행:
 *   # VT OFF 결과 저장
 *   k6 run --out json=results/ws-max-platform.json k6/ws-max-connections-test.js
 *
 *   # VT ON 결과 저장
 *   k6 run --out json=results/ws-max-virtual.json k6/ws-max-connections-test.js
 */

import http from 'k6/http';
import ws   from 'k6/ws';
import { check, sleep } from 'k6';
import { Counter, Rate, Trend, Gauge } from 'k6/metrics';

const BASE_URL    = 'http://localhost:8080';
const WS_BASE_URL = 'ws://localhost:8080';
const MSG_INTERVAL_MS  = 2000;  // 메시지 전송 간격: 2초
const HOLD_DURATION_MS = 30000; // hold 구간: 30초
const WS_TIMEOUT_MS    = 60000; // 연결 유지 최대 시간: 60초

// Custom metrics
const wsConnectErrors    = new Counter('ws_connect_errors');
const stompErrors        = new Counter('stomp_errors');
const msgSent            = new Counter('messages_sent');
const msgReceived        = new Counter('messages_received');
const connectionRefused  = new Counter('connection_refused');
const timeoutErrors      = new Counter('timeout_errors');
const errorRate          = new Rate('ws_error_rate');
const wsConnectTime      = new Trend('ws_connect_duration_ms', true);
const msgRoundTrip       = new Trend('msg_roundtrip_ms', true);
const activeConnections  = new Gauge('active_connections');

export const options = {
  stages: [
    { duration: '20s', target: 1000 },
    { duration: '30s', target: 1000 },  // hold
    { duration: '20s', target: 2000 },
    { duration: '30s', target: 2000 },  // hold
    { duration: '20s', target: 3000 },
    { duration: '30s', target: 3000 },  // hold
    { duration: '20s', target: 5000 },
    { duration: '30s', target: 5000 },  // hold
    { duration: '20s', target: 0 },
  ],
  // threshold 없음 — 한계 탐색이 목적이므로 에러 발생을 허용
};

// ---------------------------------------------------------------------------
// Helpers (ws-stomp-test.js에서 재활용)
// ---------------------------------------------------------------------------

/** Generate a random alphanumeric session/server id like SockJS expects */
function randId(len) {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  for (let i = 0; i < len; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

/**
 * Encode a STOMP frame to a string.
 * SockJS wraps it as:  ["STOMP_FRAME_STRING"]
 */
function stompFrame(command, headers, body) {
  let frame = command + '\n';
  for (const [k, v] of Object.entries(headers)) {
    frame += `${k}:${v}\n`;
  }
  frame += '\n';
  if (body) frame += body;
  frame += '\x00';
  return JSON.stringify([frame]); // SockJS array wrap
}

function parseStompFrame(raw) {
  // raw is like  a["STOMP_FRAME"]
  if (!raw || raw === 'h' || raw === 'o') return null;
  if (!raw.startsWith('a')) return null;
  try {
    const arr = JSON.parse(raw.slice(1));
    if (!Array.isArray(arr) || arr.length === 0) return null;
    const text = arr[0];
    const lines = text.split('\n');
    const command = lines[0];
    const hdrs = {};
    let i = 1;
    while (i < lines.length && lines[i] !== '') {
      const [k, ...rest] = lines[i].split(':');
      hdrs[k] = rest.join(':');
      i++;
    }
    const bodyStart = text.indexOf('\n\n') + 2;
    const body = text.slice(bodyStart).replace('\x00', '');
    return { command, headers: hdrs, body };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Main VU function
// ---------------------------------------------------------------------------

export default function () {
  const vuId   = __VU;
  const iterId = __ITER;
  const userId = `vu${vuId}-iter${iterId}`;

  // ── Step 1: Create a private room via REST ──────────────────────────────
  const createRes = http.post(
    `${BASE_URL}/api/rooms`,
    JSON.stringify({ roomName: `bench-${userId}`, creatorId: userId }),
    { headers: { 'Content-Type': 'application/json' } },
  );

  const createOk = check(createRes, { 'room created (201)': (r) => r.status === 201 });
  if (!createOk) {
    errorRate.add(1);
    wsConnectErrors.add(1);
    if (createRes.error && createRes.error.includes('connection refused')) {
      connectionRefused.add(1);
    }
    return;
  }
  errorRate.add(0);

  let roomId;
  try {
    roomId = JSON.parse(createRes.body).roomId;
  } catch {
    wsConnectErrors.add(1);
    return;
  }

  // ── Step 2: Open SockJS/WebSocket ──────────────────────────────────────
  const serverId  = Math.floor(Math.random() * 900 + 100).toString(); // 3-digit
  const sessionId = randId(8);
  const wsUrl     = `${WS_BASE_URL}/ws/${serverId}/${sessionId}/websocket`;

  const connectStart = Date.now();

  const res = ws.connect(wsUrl, {}, function (socket) {
    let connected      = false;
    let subscribed     = false;
    let joined         = false;
    let msgIndex       = 0;
    let sendTimestamps = {};

    activeConnections.add(1);

    // ── Timeout guard: close after 60s regardless ─────────────────────
    socket.setTimeout(function () {
      // LEAVE before closing
      if (joined) {
        socket.send(stompFrame('SEND', {
          destination:    '/app/room.leave',
          'content-type': 'application/json',
        }, JSON.stringify({ roomId, userId })));
      }
      socket.close();
    }, WS_TIMEOUT_MS);

    socket.on('open', function () {
      wsConnectTime.add(Date.now() - connectStart);

      // ── Step 3: STOMP CONNECT ─────────────────────────────────────
      socket.send(stompFrame('CONNECT', {
        'accept-version': '1.2',
        'heart-beat':     '0,0',
      }));
    });

    socket.on('message', function (data) {
      // SockJS open frame
      if (data === 'o') return;
      // SockJS heartbeat
      if (data === 'h') return;

      const frame = parseStompFrame(data);
      if (!frame) return;

      // ── STOMP CONNECTED → subscribe + join ───────────────────────
      if (frame.command === 'CONNECTED' && !connected) {
        connected = true;

        // ── Step 4: SUBSCRIBE ────────────────────────────────────
        socket.send(stompFrame('SUBSCRIBE', {
          id:          `sub-${vuId}`,
          destination: `/topic/room/${roomId}`,
        }));
        subscribed = true;

        // ── Step 5: JOIN ─────────────────────────────────────────
        socket.send(stompFrame('SEND', {
          destination:    '/app/room.join',
          'content-type': 'application/json',
        }, JSON.stringify({ roomId, userId })));
      }

      // ── Incoming MESSAGE frame ─────────────────────────────────────
      if (frame.command === 'MESSAGE') {
        msgReceived.add(1);

        try {
          const body = JSON.parse(frame.body);

          // Track round-trip for CHAT messages we sent
          if (body.senderId === userId && sendTimestamps[body.content]) {
            msgRoundTrip.add(Date.now() - sendTimestamps[body.content]);
            delete sendTimestamps[body.content];
          }

          // After JOIN confirmation, start periodic message sending
          if (!joined && body.type === 'JOIN' && body.senderId === userId) {
            joined = true;

            // 2초 간격으로 메시지 전송 (연결 유지 + 부하 측정)
            const sendPeriodic = function () {
              const content = `msg-${msgIndex}-from-${userId}`;
              sendTimestamps[content] = Date.now();
              socket.send(stompFrame('SEND', {
                destination:    '/app/room.send',
                'content-type': 'application/json',
              }, JSON.stringify({ roomId, senderId: userId, content, type: 'CHAT' })));
              msgSent.add(1);
              msgIndex++;
              socket.setTimeout(sendPeriodic, MSG_INTERVAL_MS);
            };
            // 첫 메시지는 즉시 전송
            sendPeriodic();
          }

          // After LEAVE or ROOM_DELETED, close the connection
          if (body.type === 'LEAVE' && body.senderId === userId) {
            socket.close();
          }
          if (body.type === 'ROOM_DELETED') {
            socket.close();
          }
        } catch {
          // ignore JSON parse errors on non-chat messages
        }
      }

      // ── ERROR frame ────────────────────────────────────────────────
      if (frame.command === 'ERROR') {
        stompErrors.add(1);
        errorRate.add(1);
        socket.close();
      }
    });

    socket.on('error', function (e) {
      wsConnectErrors.add(1);
      errorRate.add(1);
      if (e && String(e).includes('connection refused')) {
        connectionRefused.add(1);
      } else if (e && String(e).includes('timeout')) {
        timeoutErrors.add(1);
      }
    });

    socket.on('close', function () {
      activeConnections.add(-1);
      errorRate.add(0); // mark as non-error close
    });
  });

  check(res, { 'ws status 101': (r) => r && r.status === 101 });

  // Give VU a short rest before next iteration
  sleep(1);
}

// ---------------------------------------------------------------------------
// teardown – print JVM thread count
// ---------------------------------------------------------------------------
export function teardown() {
  const res = http.get(`${BASE_URL}/actuator/metrics/jvm.threads.live`);
  if (res.status === 200) {
    try {
      const data  = JSON.parse(res.body);
      const value = data.measurements.find((m) => m.statistic === 'VALUE');
      console.log(`\n[Actuator] JVM live threads at end of test: ${value ? value.value : 'N/A'}`);
    } catch {
      console.log('[Actuator] Failed to parse thread metrics');
    }
  }
}
