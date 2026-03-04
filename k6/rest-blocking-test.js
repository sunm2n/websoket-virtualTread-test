/**
 * k6 REST Blocking I/O Load Test — 시나리오 분리 버전
 *
 * 목적: Thread.sleep으로 DB I/O를 시뮬레이션하여
 *       플랫폼 쓰레드 vs 버추얼 쓰레드 성능 차이를 수치화
 *
 * 시나리오:
 *   - read_load:  GET /api/rooms 반복 (순수 읽기 성능 측정, 서버 50ms sleep)
 *   - write_load: POST /api/rooms → DELETE 사이클 (쓰기 성능 측정, 서버 100ms sleep, 방 누적 방지)
 *
 * setup()에서 시드 방 5개를 생성하여 GET 응답 크기를 일정하게 유지하고,
 * teardown()에서 시드 방을 삭제한다.
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
  scenarios: {
    read_load: {
      executor: 'ramping-vus',
      startVUs: 10,
      stages: [
        { duration: '20s', target: 300 },
        { duration: '60s', target: 600 },
        { duration: '20s', target: 0 },
      ],
      exec: 'readScenario',
    },
    write_load: {
      executor: 'ramping-vus',
      startVUs: 5,
      stages: [
        { duration: '20s', target: 100 },
        { duration: '60s', target: 200 },
        { duration: '20s', target: 0 },
      ],
      exec: 'writeScenario',
    },
  },
  thresholds: {
    error_rate:        ['rate<0.01'],
    list_latency_ms:   ['p(95)<200'],   // 50ms sleep + 여유 150ms
    create_latency_ms: ['p(95)<300'],   // 100ms sleep + 여유 200ms
  },
};

/**
 * setup: 시드 방 5개 생성 → GET 응답 크기 일정하게 유지
 */
export function setup() {
  const seedRooms = [];
  for (let i = 0; i < 5; i++) {
    const res = http.post(
      `${BASE_URL}/api/rooms`,
      JSON.stringify({ roomName: `seed-room-${i}`, creatorId: 'admin' }),
      { headers: { 'Content-Type': 'application/json' } },
    );
    if (res.status === 201) {
      try {
        seedRooms.push(JSON.parse(res.body).roomId);
      } catch { /* ignore */ }
    }
  }
  console.log(`[setup] Created ${seedRooms.length} seed rooms: ${JSON.stringify(seedRooms)}`);
  return { seedRooms };
}

/**
 * readScenario: GET /api/rooms 반복 (순수 읽기 성능 측정)
 */
export function readScenario(_data) {
  const res = http.get(`${BASE_URL}/api/rooms`);

  listLatency.add(res.timings.duration);

  const ok = check(res, { 'GET 200': (r) => r.status === 200 });
  errorRate.add(ok ? 0 : 1);
  if (!ok) listErrors.add(1);
}

/**
 * writeScenario: POST → DELETE 사이클 (쓰기 성능 측정, 방 누적 방지)
 */
export function writeScenario(_data) {
  const vuId   = __VU;
  const userId = `user-${vuId}`;

  // POST /api/rooms (서버 100ms sleep)
  const createRes = http.post(
    `${BASE_URL}/api/rooms`,
    JSON.stringify({ roomName: `room-vu${vuId}-${Date.now()}`, creatorId: userId }),
    { headers: { 'Content-Type': 'application/json' } },
  );

  createLatency.add(createRes.timings.duration);

  const createOk = check(createRes, { 'POST 201': (r) => r.status === 201 });
  errorRate.add(createOk ? 0 : 1);
  if (!createOk) createErrors.add(1);

  // DELETE: 생성한 방 즉시 삭제 → 방 누적 방지
  let roomId = null;
  try { roomId = JSON.parse(createRes.body).roomId; } catch { /* ignore */ }

  if (roomId) {
    http.del(`${BASE_URL}/api/rooms/${roomId}?userId=${userId}`, null, {
      tags: { name: 'DELETE /api/rooms/:id' },
    });
  }
}

/**
 * teardown: 시드 방 삭제 + JVM 쓰레드 수 출력
 */
export function teardown(data) {
  // 시드 방 삭제
  if (data.seedRooms) {
    for (const roomId of data.seedRooms) {
      http.del(`${BASE_URL}/api/rooms/${roomId}?userId=admin`, null, {
        tags: { name: 'DELETE /api/rooms/:id' },
      });
    }
    console.log(`[teardown] Deleted ${data.seedRooms.length} seed rooms`);
  }

  // Actuator 쓰레드 수 출력
  const res = http.get(`${BASE_URL}/actuator/metrics/jvm.threads.live`);
  if (res.status === 200) {
    try {
      const metrics = JSON.parse(res.body);
      const value = metrics.measurements.find((m) => m.statistic === 'VALUE');
      console.log(`\n[Actuator] JVM live threads at end of test: ${value ? value.value : 'N/A'}`);
    } catch {
      console.log('[Actuator] Failed to parse thread metrics');
    }
  }
}
