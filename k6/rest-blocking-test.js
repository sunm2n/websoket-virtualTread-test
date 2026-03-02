/**
 * k6 REST Blocking I/O Load Test
 *
 * 목적: Thread.sleep으로 DB I/O를 시뮬레이션하여
 *       플랫폼 쓰레드 vs 버추얼 쓰레드 성능 차이를 수치화
 *
 * 핵심 원리:
 *   - GET  /api/rooms → 서버에서 50ms sleep  (SELECT 시뮬)
 *   - POST /api/rooms → 서버에서 100ms sleep (INSERT 시뮬)
 *   - 600 VU 동시 접속 → Tomcat 기본 쓰레드 풀(200개) 3배 초과
 *
 * 플랫폼 쓰레드: 200개 쓰레드 포화 → 나머지 큐 대기 → 레이턴시 폭증
 * 버추얼 쓰레드: sleep 중 carrier thread 반납 → 제한 없이 처리 → 레이턴시 유지
 *
 * Run:
 *   # 1단계: application.properties에서 spring.threads.virtual.enabled=true 주석 처리 후 실행
 *   k6 run k6/rest-blocking-test.js
 *
 *   # 2단계: spring.threads.virtual.enabled=true 활성화 후 재실행
 *   k6 run k6/rest-blocking-test.js
 */

import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter, Rate, Trend } from 'k6/metrics';

const BASE_URL = 'http://localhost:8080';

const createErrors  = new Counter('create_errors');
const listErrors    = new Counter('list_errors');
const errorRate     = new Rate('error_rate');
const createLatency = new Trend('create_latency_ms', true);
const listLatency   = new Trend('list_latency_ms', true);

export const options = {
  stages: [
    { duration: '20s', target: 100 }, // warmup
    { duration: '30s', target: 300 }, // 300 VU: 플랫폼 쓰레드 풀(200) 초과 시작
    { duration: '30s', target: 600 }, // 600 VU: 풀 3배 → 포화 확정
    { duration: '60s', target: 600 }, // 60s 유지: 포화 상태 지속 측정
    { duration: '20s', target: 0   }, // ramp-down
  ],
  thresholds: {
    // 플랫폼 쓰레드 모드에서는 이 임계값을 초과할 것으로 예상
    // 버추얼 쓰레드 모드에서는 통과할 것으로 예상
    error_rate:        ['rate<0.01'],
    create_latency_ms: ['p(99)<500'],  // 100ms sleep + 여유 400ms
    list_latency_ms:   ['p(99)<300'],  // 50ms sleep + 여유 250ms
  },
};

export default function () {
  const vuId   = __VU;
  const userId = `user-${vuId}`;

  // POST /api/rooms  (서버 100ms sleep)
  const createRes = http.post(
    `${BASE_URL}/api/rooms`,
    JSON.stringify({ roomName: `room-vu${vuId}-${Date.now()}`, creatorId: userId }),
    { headers: { 'Content-Type': 'application/json' } },
  );

  createLatency.add(createRes.timings.duration);

  const createOk = check(createRes, { 'POST 201': (r) => r.status === 201 });
  errorRate.add(createOk ? 0 : 1);
  if (!createOk) createErrors.add(1);

  let roomId = null;
  try { roomId = JSON.parse(createRes.body).roomId; } catch { /* ignore */ }

  // GET /api/rooms  (서버 50ms sleep)
  const listRes = http.get(`${BASE_URL}/api/rooms`);

  listLatency.add(listRes.timings.duration);

  const listOk = check(listRes, { 'GET 200': (r) => r.status === 200 });
  errorRate.add(listOk ? 0 : 1);
  if (!listOk) listErrors.add(1);

  // DELETE: 생성한 방을 즉시 삭제 → 방 목록 누적 방지 → GET 응답 크기 일정하게 유지
  if (roomId) {
    http.del(`${BASE_URL}/api/rooms/${roomId}?userId=${userId}`);
  }
}

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
