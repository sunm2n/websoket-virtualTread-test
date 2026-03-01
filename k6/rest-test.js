/**
 * k6 REST API Load Test
 *
 * Scenario A: Platform Thread Saturation
 * - Ramp up to 200 VUs over 30s, hold for 60s, ramp down over 15s
 * - Each VU: POST /api/rooms → GET /api/rooms (repeated)
 * - Measures: RPS, P50/P95/P99 latency, error rate, JVM thread count
 *
 * Run:
 *   k6 run k6/rest-test.js
 *   k6 run --out json=results/rest-platform.json k6/rest-test.js
 */

import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter, Rate, Trend } from 'k6/metrics';

const BASE_URL = 'http://localhost:8080';

// Custom metrics
const createRoomErrors = new Counter('create_room_errors');
const listRoomErrors   = new Counter('list_room_errors');
const errorRate        = new Rate('error_rate');
const createLatency    = new Trend('create_room_latency', true);
const listLatency      = new Trend('list_room_latency', true);

export const options = {
  stages: [
    { duration: '30s', target: 200 }, // ramp-up
    { duration: '60s', target: 200 }, // sustained load
    { duration: '15s', target: 0   }, // ramp-down
  ],
  thresholds: {
    // Alert if P99 exceeds 1s or error rate exceeds 1%
    http_req_duration:   ['p(99)<1000'],
    error_rate:          ['rate<0.01'],
    create_room_latency: ['p(95)<500'],
    list_room_latency:   ['p(95)<200'],
  },
};

export default function () {
  const vuId    = __VU;
  const userId  = `user-${vuId}`;
  const headers = { 'Content-Type': 'application/json' };

  // --- POST /api/rooms ---
  const createPayload = JSON.stringify({
    roomName:  `room-vu${vuId}-${Date.now()}`,
    creatorId: userId,
  });

  const createRes = http.post(`${BASE_URL}/api/rooms`, createPayload, { headers });

  const createOk = check(createRes, {
    'create room status 201': (r) => r.status === 201,
    'create room has roomId': (r) => {
      try { return JSON.parse(r.body).roomId !== undefined; }
      catch { return false; }
    },
  });

  createLatency.add(createRes.timings.duration);

  if (!createOk) {
    createRoomErrors.add(1);
    errorRate.add(1);
  } else {
    errorRate.add(0);
  }

  // Small pause to simulate realistic user behaviour
  sleep(0.1);

  // --- GET /api/rooms ---
  const listRes = http.get(`${BASE_URL}/api/rooms`);

  const listOk = check(listRes, {
    'list rooms status 200': (r) => r.status === 200,
    'list rooms is array':   (r) => {
      try { return Array.isArray(JSON.parse(r.body)); }
      catch { return false; }
    },
  });

  listLatency.add(listRes.timings.duration);

  if (!listOk) {
    listRoomErrors.add(1);
    errorRate.add(1);
  } else {
    errorRate.add(0);
  }

  sleep(0.1);
}

/**
 * Print a summary of JVM thread count at test end.
 * Run the server with Actuator enabled; this queries metrics.
 */
export function teardown() {
  const res = http.get(`${BASE_URL}/actuator/metrics/jvm.threads.live`);
  if (res.status === 200) {
    try {
      const data = JSON.parse(res.body);
      const value = data.measurements.find((m) => m.statistic === 'VALUE');
      console.log(`\n[Actuator] JVM live threads at end of test: ${value ? value.value : 'N/A'}`);
    } catch (e) {
      console.log('[Actuator] Failed to parse thread metrics');
    }
  }
}
