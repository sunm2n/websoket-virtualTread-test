/**
 * REST 엔드포인트 부하 테스트
 *
 * 테스트 목적:
 *   GET /api/rooms → 50ms blocking (DB SELECT 시뮬레이션)
 *   POST /api/rooms → 100ms blocking (DB INSERT 시뮬레이션)
 *   이 상태에서 동시 사용자를 늘렸을 때 Virtual Thread ON/OFF 처리량 차이를 측정
 *
 * 실행 방법:
 *   1. 서버 실행 (Virtual Thread ON):  spring.threads.virtual.enabled=true
 *   2. k6 run load-test/rest-load-test.js
 *   3. 서버 재실행 (Virtual Thread OFF): spring.threads.virtual.enabled=false
 *   4. k6 run load-test/rest-load-test.js
 *   5. 두 결과의 p95 latency, req/s 비교
 *
 * 설치: brew install k6  또는  https://k6.io/docs/getting-started/installation
 */

import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter, Rate, Trend } from 'k6/metrics';

const BASE_URL = 'http://localhost:8080';

const errorRate = new Rate('errors');
const getRoomsDuration = new Trend('get_rooms_duration', true);
const createRoomDuration = new Trend('create_room_duration', true);

export const options = {
  scenarios: {
    // Tomcat 기본 스레드 200개 초과 시점부터 차이가 드러남
    ramp_up: {
      executor: 'ramping-vus',
      startVUs: 10,
      stages: [
        { duration: '10s', target: 100 },  // 서서히 올림
        { duration: '20s', target: 300 },  // Tomcat 기본 풀(200) 포화 구간
        { duration: '10s', target: 300 },  // 포화 상태 유지
        { duration: '10s', target: 0 },    // 감소
      ],
    },
  },
  thresholds: {
    // Virtual Thread ON이면 300 VU에서도 p95 < 300ms 유지되어야 함
    // Virtual Thread OFF면 200 VU 초과 시 급격히 증가
    'get_rooms_duration': ['p(95)<300'],
    'errors': ['rate<0.05'],
  },
};

export function setup() {
  // 테스트용 방 5개 미리 생성
  for (let i = 1; i <= 5; i++) {
    http.post(
      `${BASE_URL}/api/rooms`,
      JSON.stringify({ roomName: `Room-${i}`, creatorId: `setup-user` }),
      { headers: { 'Content-Type': 'application/json' } }
    );
  }
}

export default function () {
  // 80% GET, 20% POST (실제 채팅 앱 읽기 비율 반영)
  if (Math.random() < 0.8) {
    const res = http.get(`${BASE_URL}/api/rooms`);
    getRoomsDuration.add(res.timings.duration);
    errorRate.add(!check(res, { 'GET 200': (r) => r.status === 200 }));
  } else {
    const res = http.post(
      `${BASE_URL}/api/rooms`,
      JSON.stringify({
        roomName: `Room-${__VU}-${__ITER}`,
        creatorId: `user-${__VU}`,
      }),
      { headers: { 'Content-Type': 'application/json' } }
    );
    createRoomDuration.add(res.timings.duration);
    errorRate.add(!check(res, { 'POST 201': (r) => r.status === 201 }));
  }
}
