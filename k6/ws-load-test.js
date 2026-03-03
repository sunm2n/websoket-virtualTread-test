/**
 * WebSocket STOMP 부하 테스트 (SockJS 프로토콜)
 *
 * 테스트 목적:
 *   - 다수 사용자가 동시에 WebSocket 연결 후 메시지 전송
 *   - sendMessage: 100ms blocking (DB 저장 시뮬레이션)
 *   - joinRoom:    50ms  blocking (DB 조회 시뮬레이션)
 *   - STOMP inbound channel이 Virtual Thread일 때와 platform thread일 때 처리량 비교
 *
 * 실행 방법:
 *   1. 서버 실행 후 방 1개 미리 생성 (아래 ROOM_ID를 실제 값으로 교체)
 *      curl -X POST http://localhost:8080/api/rooms \
 *           -H 'Content-Type: application/json' \
 *           -d '{"roomName":"load-test-room","creatorId":"admin"}'
 *   2. 응답의 roomId를 아래 ROOM_ID에 입력
 *   3. spring.threads.virtual.enabled=true 로 서버 실행 → k6 run load-test/ws-load-test.js
 *   4. spring.threads.virtual.enabled=false 로 서버 재실행 → k6 run load-test/ws-load-test.js
 *
 * 설치: brew install k6
 */

import ws from 'k6/ws';
import { check, sleep } from 'k6';
import { Counter, Rate, Trend } from 'k6/metrics';

const BASE_URL = 'http://localhost:8080';
const WS_BASE  = 'ws://localhost:8080';

// ★ curl로 방 생성 후 얻은 roomId로 교체
const ROOM_ID = 'REPLACE_WITH_ACTUAL_ROOM_ID';

const connectSuccess  = new Rate('ws_connect_success');
const msgSentCount    = new Counter('ws_messages_sent');
const msgReceivedCount = new Counter('ws_messages_received');
const e2eLatency      = new Trend('ws_e2e_latency_ms', true);
const errorRate       = new Rate('ws_errors');

export const options = {
  scenarios: {
    websocket_flood: {
      executor: 'ramping-vus',
      startVUs: 10,
      stages: [
        { duration: '10s', target: 50  },
        { duration: '20s', target: 200 }, // STOMP 기본 풀(platform thread) 포화 구간
        { duration: '10s', target: 200 },
        { duration: '10s', target: 0   },
      ],
    },
  },
  thresholds: {
    'ws_connect_success': ['rate>0.95'],
    'ws_e2e_latency_ms':  ['p(95)<500'],
    'ws_errors':          ['rate<0.05'],
  },
};

/** SockJS WebSocket 전송 URL 생성 */
function sockjsUrl() {
  const server  = String(Math.floor(Math.random() * 999) + 1).padStart(3, '0');
  const session = Array.from({ length: 8 }, () =>
    Math.random().toString(36).charAt(2)
  ).join('');
  return `${WS_BASE}/ws/${server}/${session}/websocket`;
}

/** STOMP 프레임을 SockJS 데이터 프레임으로 래핑 */
function sockjsSend(socket, stompFrame) {
  socket.send(JSON.stringify([stompFrame]));
}

/** STOMP 프레임 문자열 생성 */
function stompFrame(command, headers = {}, body = '') {
  let frame = `${command}\n`;
  for (const [k, v] of Object.entries(headers)) {
    frame += `${k}:${v}\n`;
  }
  frame += `\n${body}\0`;
  return frame;
}

export default function () {
  const userId = `user-${__VU}-${__ITER}`;
  const url    = sockjsUrl();

  let connectTime = Date.now();
  let sentAt      = 0;
  let joined      = false;

  const res = ws.connect(url, {}, (socket) => {
    // SockJS 개방 프레임 수신 → STOMP CONNECT 전송
    socket.on('open', () => {
      connectSuccess.add(true);
    });

    socket.on('message', (raw) => {
      // SockJS 프레임 파싱
      if (raw === 'o') {
        // SockJS 세션 열림 → STOMP 연결 시작
        sockjsSend(socket, stompFrame('CONNECT', {
          'accept-version': '1.1,1.0',
          'heart-beat': '0,0',
        }));
        return;
      }

      if (raw === 'h') return; // heartbeat 무시

      if (!raw.startsWith('a')) return;

      // SockJS 데이터 프레임: a["STOMP FRAME"]
      let frames;
      try {
        frames = JSON.parse(raw.slice(1));
      } catch (_) {
        return;
      }

      for (const frame of frames) {
        msgReceivedCount.add(1);

        if (frame.startsWith('CONNECTED')) {
          // STOMP 연결 완료 → 방 구독 후 입장
          sockjsSend(socket, stompFrame('SUBSCRIBE', {
            id: 'sub-room',
            destination: `/topic/room/${ROOM_ID}`,
          }));
          sockjsSend(socket, stompFrame('SEND', {
            destination: '/app/room.join',
            'content-type': 'application/json',
          }, JSON.stringify({ roomId: ROOM_ID, userId })));

        } else if (frame.includes('"JOIN"') && !joined) {
          // 입장 확인 → 메시지 전송 시작
          joined = true;
          sentAt = Date.now();
          sockjsSend(socket, stompFrame('SEND', {
            destination: '/app/room.send',
            'content-type': 'application/json',
          }, JSON.stringify({
            roomId: ROOM_ID,
            sender: userId,
            content: `hello from ${userId}`,
          })));
          msgSentCount.add(1);

        } else if (frame.includes('"CHAT"') && sentAt > 0) {
          // 내가 보낸 메시지가 브로드캐스트되어 돌아옴 → RTT 측정
          e2eLatency.add(Date.now() - sentAt);
          sentAt = 0;

          // 추가 메시지 1회 더 전송
          sleep(0.5);
          sentAt = Date.now();
          sockjsSend(socket, stompFrame('SEND', {
            destination: '/app/room.send',
            'content-type': 'application/json',
          }, JSON.stringify({
            roomId: ROOM_ID,
            sender: userId,
            content: `msg2 from ${userId}`,
          })));
          msgSentCount.add(1);
        }
      }
    });

    socket.on('error', () => {
      connectSuccess.add(false);
      errorRate.add(true);
    });

    // 최대 15초 후 연결 종료
    socket.setTimeout(() => {
      sockjsSend(socket, stompFrame('SEND', {
        destination: '/app/room.leave',
        'content-type': 'application/json',
      }, JSON.stringify({ roomId: ROOM_ID, userId })));
      socket.close();
    }, 15000);
  });

  check(res, { 'WebSocket 101 Upgrade': (r) => r && r.status === 101 });
  errorRate.add(res === null || res.status !== 101);
}
