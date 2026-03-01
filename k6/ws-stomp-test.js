/**
 * k6 WebSocket STOMP Load Test
 *
 * Scenario B: Concurrent WebSocket Connections + Message Throughput
 * - Staged ramp: 0 → 100 → 500 → 1000 concurrent connections
 * - Each VU:
 *     1. POST /api/rooms  (create a private room)
 *     2. Open SockJS WebSocket  ws://localhost:8080/ws/{server}/{session}/websocket
 *     3. STOMP CONNECT
 *     4. SUBSCRIBE /topic/room/<roomId>
 *     5. STOMP SEND /app/room.join
 *     6. Send 20 chat messages (100 ms apart)
 *     7. STOMP SEND /app/room.leave
 *     8. Close connection
 * - Measures: concurrent connections, msg throughput, P99 latency, JVM threads
 *
 * Run:
 *   k6 run k6/ws-stomp-test.js
 *   k6 run --out json=results/ws-platform.json k6/ws-stomp-test.js
 */

import http from 'k6/http';
import ws   from 'k6/ws';
import { check, sleep } from 'k6';
import { Counter, Rate, Trend, Gauge } from 'k6/metrics';

const BASE_URL    = 'http://localhost:8080';
const WS_BASE_URL = 'ws://localhost:8080';
const MESSAGES_PER_VU = 20;

// Custom metrics
const wsConnectErrors  = new Counter('ws_connect_errors');
const stompErrors      = new Counter('stomp_errors');
const msgSent          = new Counter('messages_sent');
const msgReceived      = new Counter('messages_received');
const errorRate        = new Rate('ws_error_rate');
const wsConnectTime    = new Trend('ws_connect_duration_ms', true);
const msgRoundTrip     = new Trend('msg_roundtrip_ms', true);

export const options = {
  stages: [
    { duration: '20s', target: 100  }, // 0 → 100  connections
    { duration: '30s', target: 100  }, // hold
    { duration: '30s', target: 500  }, // 100 → 500
    { duration: '30s', target: 500  }, // hold
    { duration: '30s', target: 1000 }, // 500 → 1000
    { duration: '30s', target: 1000 }, // hold
    { duration: '20s', target: 0    }, // ramp-down
  ],
  thresholds: {
    ws_error_rate:         ['rate<0.05'],   // <5 % WS errors acceptable
    ws_connect_duration_ms: ['p(95)<3000'], // connect within 3s
    msg_roundtrip_ms:       ['p(99)<2000'], // echo within 2s
  },
};

// ---------------------------------------------------------------------------
// Helpers
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
    let sentCount      = 0;
    let receivedCount  = 0;
    let sendTimestamps = {};

    // ── Timeout guard: close after 30s regardless ─────────────────────
    socket.setTimeout(function () {
      socket.close();
    }, 30000);

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
          destination: '/app/room.join',
        }, JSON.stringify({ roomId, userId })));
      }

      // ── Incoming MESSAGE frame ─────────────────────────────────────
      if (frame.command === 'MESSAGE') {
        receivedCount++;
        msgReceived.add(1);

        // Track round-trip for CHAT messages we sent
        try {
          const body = JSON.parse(frame.body);
          if (body.sender === userId && sendTimestamps[body.content]) {
            msgRoundTrip.add(Date.now() - sendTimestamps[body.content]);
            delete sendTimestamps[body.content];
          }

          // After JOIN confirmation, start sending chat messages
          if (!joined && body.type === 'JOIN' && body.sender === userId) {
            joined = true;
            // ── Step 6: Send 20 messages (100ms apart) ────────────
            let i = 0;
            const sendNext = function () {
              if (i >= MESSAGES_PER_VU) {
                // ── Step 7: LEAVE ──────────────────────────────
                socket.send(stompFrame('SEND', {
                  destination: '/app/room.leave',
                }, JSON.stringify({ roomId, userId })));
                return;
              }
              const content = `msg-${i}-from-${userId}`;
              sendTimestamps[content] = Date.now();
              socket.send(stompFrame('SEND', {
                destination:   '/app/room.send',
                'content-type': 'application/json',
              }, JSON.stringify({ roomId, sender: userId, content, type: 'CHAT' })));
              msgSent.add(1);
              i++;
              socket.setTimeout(sendNext, 100);
            };
            sendNext();
          }

          // After LEAVE or ROOM_DELETED, close the connection
          if (body.type === 'LEAVE' && body.sender === userId) {
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
    });

    socket.on('close', function () {
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
