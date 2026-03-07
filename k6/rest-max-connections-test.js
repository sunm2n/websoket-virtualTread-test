/**
 * k6 REST 최대 동시 연결 한계 테스트
 *
 * 목적: VU를 단계적으로 올려 첫 에러가 발생하는 지점을 찾고,
 *       Platform Thread vs Virtual Thread의 수용 능력 차이를 수치화한다.
 *
 * 시나리오:
 *   - read_load:  GET /api/rooms 반복 (서버 50ms sleep)
 *     VU 단계: 300 → 600 → 900 → 1,500 → 2,500
 *   - write_load: POST /api/rooms → DELETE 사이클 (서버 100ms sleep)
 *     VU 단계: 100 → 200 → 300 → 500 → 800
 *   - 합계: ~400 → ~800 → ~1,200 → ~2,000 → ~3,300
 *
 * 각 단계 30초 hold하여 안정 상태 측정.
 * threshold 없음 — 한계 탐색이 목적이므로 에러 발생을 허용.
 *
 * 실행 전 준비:
 *   1. ulimit -n 확인 및 상향 (최소 10,000)
 *      ulimit -n 10240
 *   2. 서버 실행 (VT OFF 먼저, 이후 VT ON으로 재실행)
 *
 * 실행:
 *   # VT OFF 결과 저장
 *   k6 run --out json=results/rest-max-platform.json k6/rest-max-connections-test.js
 *
 *   # VT ON 결과 저장
 *   k6 run --out json=results/rest-max-virtual.json k6/rest-max-connections-test.js
 */

import http from 'k6/http';
import { check } from 'k6';
import { Counter, Rate, Trend } from 'k6/metrics';

const BASE_URL = 'http://localhost:8080';

// Custom metrics
const createErrors      = new Counter('create_errors');
const listErrors        = new Counter('list_errors');
const connectionRefused = new Counter('connection_refused');
const timeoutErrors     = new Counter('timeout_errors');
const errorRate         = new Rate('error_rate');
const createLatency     = new Trend('create_latency_ms', true);
const listLatency       = new Trend('list_latency_ms', true);

export const options = {
  scenarios: {
    read_load: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '20s', target: 300 },
        { duration: '30s', target: 300 },   // hold
        { duration: '20s', target: 600 },
        { duration: '30s', target: 600 },   // hold
        { duration: '20s', target: 900 },
        { duration: '30s', target: 900 },   // hold
        { duration: '20s', target: 1500 },
        { duration: '30s', target: 1500 },  // hold
        { duration: '20s', target: 2500 },
        { duration: '30s', target: 2500 },  // hold
        { duration: '20s', target: 0 },
      ],
      exec: 'readScenario',
    },
    write_load: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '20s', target: 100 },
        { duration: '30s', target: 100 },   // hold
        { duration: '20s', target: 200 },
        { duration: '30s', target: 200 },   // hold
        { duration: '20s', target: 300 },
        { duration: '30s', target: 300 },   // hold
        { duration: '20s', target: 500 },
        { duration: '30s', target: 500 },   // hold
        { duration: '20s', target: 800 },
        { duration: '30s', target: 800 },   // hold
        { duration: '20s', target: 0 },
      ],
      exec: 'writeScenario',
    },
  },
  // threshold 없음 — 한계 탐색이 목적이므로 에러 발생을 허용
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
  if (!ok) {
    listErrors.add(1);
    classifyError(res);
  }
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
  if (!createOk) {
    createErrors.add(1);
    classifyError(createRes);
  }

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
 * 에러 유형 분류 (connection refused vs timeout)
 */
function classifyError(res) {
  if (res.error && res.error.includes('connection refused')) {
    connectionRefused.add(1);
  } else if (res.error && (res.error.includes('timeout') || res.error.includes('i/o timeout'))) {
    timeoutErrors.add(1);
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
