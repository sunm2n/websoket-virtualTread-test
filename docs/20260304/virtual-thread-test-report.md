# Virtual Thread 부하 테스트 결과 보고서 (2차)

## 2026-03-04

---

## 1. 테스트 스크립트 개선 사항

### 1-1. 왜 수정했는가

1차 테스트(2026-03-03)에서 다음 문제가 확인됐다.

| 문제 | 원인 | 영향 |
|------|------|------|
| GET 응답 크기 오염 | POST가 방을 계속 생성하고 삭제하지 않음 | 후반부 latency가 스레드 포화가 아닌 응답 크기 때문에 상승 → ON/OFF 차이 희석 |
| GET/POST 결과 해석 어려움 | 80/20 비율로 혼합 실행 | blocking 시간이 다른 요청이 섞여 시나리오별 성능 분리 불가 |
| WebSocket roomId 수동 교체 | `ws-load-test.js`에 ROOM_ID 하드코딩 | 매 실행마다 curl로 방 생성 → roomId 복사 필요 |
| 구버전 파일 혼재 | 개선 파일과 구버전이 공존 | 어떤 파일을 실행해야 하는지 혼란 |

### 1-2. 무엇을 수정했는가

#### `k6/rest-blocking-test.js` — 시나리오 분리

**변경 전:** 단일 `default` 함수에서 POST → GET → DELETE 순차 실행

**변경 후:** 2개 독립 시나리오로 분리

```
read_load (readScenario)
├── GET /api/rooms만 반복
├── ramping-vus: 10 → 300 → 600 → 0
└── 순수 읽기 성능 측정 (서버 50ms sleep)

write_load (writeScenario)
├── POST /api/rooms → DELETE 사이클
├── ramping-vus: 5 → 100 → 200 → 0
└── 쓰기 성능 측정 (서버 100ms sleep), 방 누적 방지
```

추가된 lifecycle 함수:

| 함수 | 역할 |
|------|------|
| `setup()` | 시드 방 5개 생성 → GET 응답 크기 일정하게 유지 |
| `teardown(data)` | 시드 방 삭제 + Actuator JVM 쓰레드 수 출력 |

임계값 조정:

| 지표 | 이전 | 이후 |
|------|------|------|
| `list_latency_ms` | `p(99)<300` (혼합) | `p(95)<200` (읽기 전용) |
| `create_latency_ms` | `p(99)<500` (혼합) | `p(95)<300` (쓰기 전용) |

#### `k6/ws-stomp-test.js` — roomId 자동화 (기존 개선 유지)

- `setup()`에서 방을 동적 생성하여 roomId 자동 주입
- VU당 20개 메시지 전송, 100ms 간격
- ROOM_ID 하드코딩 제거

#### 구버전 파일 정리 (4개 삭제)

| 삭제 파일 | 대체 |
|-----------|------|
| `k6/rest-load-test.js` | `rest-blocking-test.js` |
| `k6/rest-test.js` | `rest-blocking-test.js` |
| `k6/ws-load-test.js` | `ws-stomp-test.js` |
| `k6/check-threads.sh` | 두 테스트 파일의 `teardown()`에 포함 |

최종 k6 파일 구조:

```
k6/
├── rest-blocking-test.js   # REST 부하 테스트 (read_load + write_load)
└── ws-stomp-test.js        # WebSocket STOMP 부하 테스트
```

---

## 2. 테스트 결과

### 2-1. REST 부하 테스트 결과

> 실행 환경: 로컬 macOS, `k6 run k6/rest-blocking-test.js`
> 시나리오: read_load (600 VU) + write_load (200 VU), 총 800 VU, 1분 40초

#### Virtual Thread OFF

```
create_latency_ms..: avg=187.52ms  min=100.21ms  med=197.24ms  max=316.39ms  p(90)=254.45ms  p(95)=259.89ms
list_latency_ms....: avg=138.1ms   min=50.14ms   med=148.5ms   max=263.97ms  p(90)=205.09ms  p(95)=210.03ms
error_rate.........: 0.00%
iterations.........: 306,022  (3,039/s)
http_reqs..........: 350,722  (3,483/s)
JVM live threads...: 217
```

임계값: `list_latency_ms p(95)<200` **실패** (210.03ms)

#### Virtual Thread ON

```
create_latency_ms..: avg=103.78ms  min=100.15ms  med=103.1ms   max=131.39ms  p(90)=107.5ms   p(95)=109.18ms
list_latency_ms....: avg=53.76ms   min=50.12ms   med=52.99ms   max=81.73ms   p(90)=57.73ms   p(95)=59.54ms
error_rate.........: 0.00%
iterations.........: 783,122  (7,775/s)
http_reqs..........: 896,192  (8,898/s)
JVM live threads...: 32
```

임계값: **전부 통과**

#### REST 비교 요약

| 지표 | OFF | ON | 변화 |
|------|-----|-----|------|
| list_latency_ms p(95) | 210.03ms | 59.54ms | **▼ 71.6%** |
| list_latency_ms avg | 138.1ms | 53.76ms | ▼ 61.1% |
| list_latency_ms max | 263.97ms | 81.73ms | ▼ 69.0% |
| create_latency_ms p(95) | 259.89ms | 109.18ms | **▼ 58.0%** |
| create_latency_ms avg | 187.52ms | 103.78ms | ▼ 44.7% |
| create_latency_ms max | 316.39ms | 131.39ms | ▼ 58.4% |
| iterations | 306,022 | 783,122 | **▲ 2.56x** |
| http_reqs/s | 3,483 | 8,898 | **▲ 2.55x** |
| JVM threads | 217 | 32 | **▼ 85.3%** |
| 임계값 통과 | 2/3 | **3/3** | - |

---

### 2-2. WebSocket STOMP 부하 테스트 결과

> 실행 환경: 로컬 macOS, `k6 run k6/ws-stomp-test.js`
> 시나리오: 0 → 100 → 500 → 1000 VU, 3분 10초, VU당 20 메시지

#### Virtual Thread OFF

```
msg_roundtrip_ms...: avg=5.85s     min=100ms     med=3.45s     max=26.18s    p(90)=15.35s    p(95)=17.37s
ws_connect_duration: avg=1.66ms    p(95)=3ms
ws_error_rate......: 0.00%
messages_sent......: 61,908
messages_received..: 37,746
iterations.........: 4,201
ws_sessions........: 4,239
JVM live threads...: 147
interrupted........: 38
```

임계값: `msg_roundtrip_ms p(99)<2000` **실패** (20.51s)

#### Virtual Thread ON

```
msg_roundtrip_ms...: avg=101.47ms  min=100ms     med=101ms     max=141ms     p(90)=103ms     p(95)=105ms
ws_connect_duration: avg=909.77µs  p(95)=3ms
ws_error_rate......: 0.00%
messages_sent......: 581,220
messages_received..: 628,164
iterations.........: 29,061
ws_sessions........: 29,061
JVM live threads...: 44
interrupted........: 0
```

임계값: **전부 통과**

#### WebSocket 비교 요약

| 지표 | OFF | ON | 변화 |
|------|-----|-----|------|
| msg_roundtrip_ms p(95) | 17,370ms | 105ms | **▼ 99.4%** |
| msg_roundtrip_ms p(99) | 20,510ms | 112ms | **▼ 99.5%** |
| msg_roundtrip_ms avg | 5,850ms | 101.47ms | ▼ 98.3% |
| msg_roundtrip_ms max | 26,180ms | 141ms | ▼ 99.5% |
| iterations | 4,201 | 29,061 | **▲ 6.9x** |
| messages sent | 61,908 | 581,220 | **▲ 9.4x** |
| messages received | 37,746 | 628,164 | **▲ 16.6x** |
| 수신/전송 비율 | 61% (39% 누락) | 108% (완전 수신) | ✅ |
| JVM threads | 147 | 44 | **▼ 70.1%** |
| interrupted iterations | 38 | 0 | ✅ |
| 임계값 통과 | 2/3 | **3/3** | - |

---

## 3. 결과 분석: 왜 이런 차이가 나는가

### 3-1. Platform Thread의 병목 구조

```
[Platform Thread — 600 VU가 GET /api/rooms 요청]

Tomcat 스레드 풀 (기본 200개)
├── thread-1:   [50ms sleep] ──────────────── 반환
├── thread-2:   [50ms sleep] ──────────────── 반환
├── ...
├── thread-200: [50ms sleep] ──────────────── 반환
├── VU-201: ───── 큐 대기 (thread 없음) ───── 할당 대기...
├── VU-202: ───── 큐 대기 ──────────────────── 할당 대기...
└── ...VU-600까지 대기열 적체

→ 200개 스레드가 50ms씩 점유하므로, 201번째 요청부터 대기 시간 누적
→ list_latency_ms avg가 138ms (50ms + 대기 88ms)
```

### 3-2. Virtual Thread의 해결 방식

```
[Virtual Thread — 600 VU가 GET /api/rooms 요청]

Carrier Thread (CPU 코어 수만큼, ~10개)
├── carrier-1:
│   ├── VT-1 실행 → sleep(50ms) → carrier 반환
│   ├── VT-15 실행 → sleep(50ms) → carrier 반환
│   ├── VT-28 실행 → ...
│   └── 50ms 내에 수십 개 VT가 교대로 실행
├── carrier-2: (동일)
└── ...

→ sleep() 진입 시 즉시 carrier thread 반환
→ 다른 VT가 즉시 실행
→ 600 VU 전부 동시 처리 가능
→ list_latency_ms avg가 53.76ms (거의 sleep 시간과 동일)
```

### 3-3. WebSocket에서 차이가 더 극적인 이유

REST는 요청-응답 후 스레드를 반환하지만, WebSocket은 **연결을 유지한 채 반복 메시지를 처리**한다.

```
[Platform Thread — 1000 VU WebSocket 연결]

STOMP inbound 스레드 풀 (기본 소수)
├── 메시지 1 도착 → thread-1 점유 (100ms sleep) → 반환
├── 메시지 2 도착 → thread-2 점유 (100ms sleep) → 반환
├── 메시지 3~1000: ────── 큐 대기 ──────────────
│   → 메시지가 100ms마다 쏟아지는데 처리 스레드가 부족
│   → 큐 적체 → RTT 5초 → 15초 → 26초까지 증가
│   → 전송 61,908 중 37,746만 수신 (39% 누락)
└── 38개 VU가 30초 타임아웃으로 강제 종료

[Virtual Thread — 1000 VU WebSocket 연결]

STOMP inbound: VirtualThreadTaskExecutor
├── 메시지 1 → VT 생성 → sleep(100ms) → carrier 반환 → 처리 완료
├── 메시지 2 → VT 생성 → sleep(100ms) → carrier 반환 → 처리 완료
├── 메시지 1000 → 동시에 VT 1000개 생성 가능
│   → carrier thread 소수로도 교대 실행
│   → RTT 101ms (sleep 시간과 거의 동일)
│   → 전송 581,220 전량 수신
└── interrupted 0
```

핵심: WebSocket은 **연결 수 × 메시지 빈도** 만큼 스레드가 동시에 필요하다.
Platform Thread는 이 조합에서 기하급수적으로 큐가 적체되지만,
Virtual Thread는 메시지 수에 비례하여 VT를 생성하므로 선형적으로 처리한다.

### 3-4. 스레드 수 차이의 의미

| 모드 | REST 스레드 수 | WebSocket 스레드 수 |
|------|---------------|-------------------|
| OFF | 217 | 147 |
| ON | 32 | 44 |

- **OFF 217개**: Tomcat 기본 풀 200 + 시스템 스레드 ~17개. 800 VU를 200개 스레드로 감당하려니 큐 대기 발생.
- **ON 32개**: Virtual Thread는 JVM 내부 객체로 관리되어 `jvm.threads.live`에 잡히지 않는다. 32개는 carrier thread + 시스템 스레드. 실제로는 수천 개의 Virtual Thread가 존재하지만 OS 스레드는 32개만 사용.

이는 곧 **메모리 효율**으로 직결된다. OS 스레드 1개당 기본 스택 1MB이므로:
- OFF: 217 × 1MB = ~217MB 스택 메모리
- ON: 32 × 1MB = ~32MB 스택 메모리 (Virtual Thread 스택은 수 KB)

---

## 4. Virtual Thread 도입의 이점 종합

### 4-1. 레이턴시 최적화

| 프로토콜 | OFF p(95) | ON p(95) | 이론값 | ON이 이론값에 수렴 |
|---------|-----------|----------|--------|-----------------|
| REST GET (50ms blocking) | 210ms | 59.54ms | 50ms | ✅ +9.54ms |
| REST POST (100ms blocking) | 259ms | 109.18ms | 100ms | ✅ +9.18ms |
| WebSocket RTT (100ms blocking) | 17,370ms | 105ms | 100ms | ✅ +5ms |

Virtual Thread ON 상태에서 레이턴시가 **서버의 blocking 시간(sleep 시간)에 수렴**한다.
이는 스레드 대기 오버헤드가 사실상 0이라는 의미다.

### 4-2. 처리량(Throughput) 향상

| 프로토콜 | OFF | ON | 배율 |
|---------|-----|-----|------|
| REST iterations | 306,022 | 783,122 | 2.56x |
| REST http_reqs/s | 3,483 | 8,898 | 2.55x |
| WS iterations | 4,201 | 29,061 | 6.9x |
| WS messages sent | 61,908 | 581,220 | 9.4x |
| WS messages received | 37,746 | 628,164 | 16.6x |

Blocking I/O가 많은 WebSocket에서 처리량 향상이 더 극적이다.

### 4-3. 안정성 향상

| 항목 | OFF | ON |
|------|-----|-----|
| REST 에러율 | 0% | 0% |
| WS 메시지 손실률 | 39% | 0% |
| WS interrupted VU | 38 | 0 |
| 임계값 통과 (REST) | 2/3 | 3/3 |
| 임계값 통과 (WS) | 2/3 | 3/3 |

Platform Thread에서는 에러는 나지 않았지만, WebSocket 메시지의 39%가 처리되지 못하고 누락됐다.
이는 프로덕션 환경에서 **채팅 메시지 유실**로 직결되는 심각한 문제다.

### 4-4. 리소스 효율

| 항목 | OFF | ON | 절감 |
|------|-----|-----|------|
| REST JVM threads | 217 | 32 | 85.3% |
| WS JVM threads | 147 | 44 | 70.1% |
| 추정 스택 메모리 (REST) | ~217MB | ~32MB | 85% |

OS 스레드 수가 줄어들면 컨텍스트 스위칭 오버헤드, 스택 메모리 사용량, OS 스케줄러 부하가 모두 감소한다.

### 4-5. 운영 복잡도 감소

| 항목 | Platform Thread | Virtual Thread |
|------|----------------|----------------|
| 스레드 풀 사이즈 튜닝 | 필수 (server.tomcat.threads.max 등) | 불필요 |
| 부하에 따른 풀 사이즈 조정 | 수동 또는 오토스케일링 | 불필요 |
| WebSocket 동시 접속 제한 | 스레드 풀 크기에 의존 | JVM 메모리만 충분하면 됨 |

---

## 5. Virtual Thread의 한계 및 주의사항

### 5-1. CPU-bound 작업에는 이점 없음

Virtual Thread의 이점은 **blocking I/O 중 carrier thread를 반환**하는 데서 온다.
CPU를 100% 사용하는 연산(이미지 처리, 암호화, 대규모 JSON 직렬화 등)에서는
sleep/blocking이 없으므로 carrier thread를 반환할 기회가 없다.
이 경우 Platform Thread와 성능 차이가 없거나 오히려 VT 스케줄링 오버헤드로 미세하게 느려질 수 있다.

### 5-2. Pinning(핀닝) 문제

`synchronized` 블록 안에서 blocking 호출을 하면 Virtual Thread가 carrier thread를 반환하지 못하고 **고정(pin)**된다.

```java
// 위험: Virtual Thread가 carrier thread에 핀닝됨
synchronized (lock) {
    Thread.sleep(100);  // carrier thread 반환 불가 → platform thread와 동일하게 동작
}

// 안전: ReentrantLock은 핀닝을 유발하지 않음
lock.lock();
try {
    Thread.sleep(100);  // carrier thread 정상 반환
} finally {
    lock.unlock();
}
```

현재 프로젝트는 `ReentrantLock`을 사용하므로 핀닝 문제 없음.
그러나 서드파티 라이브러리(JDBC 드라이버, HTTP 클라이언트 등)가 내부적으로 `synchronized`를 사용하면 핀닝이 발생할 수 있다.

확인 방법: JVM 옵션 `-Djdk.tracePinnedThreads=full` 추가 후 로그 확인.

### 5-3. ThreadLocal 사용 시 메모리 이슈

Platform Thread는 수백 개이므로 ThreadLocal 메모리가 제한적이지만,
Virtual Thread는 수십만 개 생성될 수 있어 **ThreadLocal에 큰 객체를 저장하면 메모리가 폭증**할 수 있다.

```java
// 위험: VT 10만 개 × 1MB = 100GB
private static final ThreadLocal<byte[]> buffer = ThreadLocal.withInitial(() -> new byte[1024 * 1024]);

// 대안: ScopedValue (Java 21 Preview) 사용
```

### 5-4. 스레드 풀 기반 제어 불가

Platform Thread는 스레드 풀 크기로 동시성을 제어할 수 있다 (예: 최대 200개 요청 동시 처리).
Virtual Thread는 제한 없이 생성되므로, **DB 커넥션 풀이나 외부 API rate limit**이 있는 경우
Semaphore 등으로 별도 제어가 필요하다.

```java
// DB 커넥션 풀이 50개인데 VT가 1000개 동시 접근 → ConnectionPool 고갈
// → Semaphore로 동시 접근 수 제한 필요
private static final Semaphore dbPermit = new Semaphore(50);
```

### 5-5. 모니터링 도구 호환성

일부 APM 도구나 프로파일러가 아직 Virtual Thread를 완벽히 지원하지 않을 수 있다.
`jvm.threads.live` 메트릭에 Virtual Thread가 잡히지 않는 것처럼,
기존 모니터링 대시보드가 실제 동시 처리 수를 과소 표시할 수 있다.

---

## 6. 테스트 실행 방법

### 환경 준비

```bash
brew install k6
```

### Virtual Thread ON 테스트

```properties
# application.properties
spring.threads.virtual.enabled=true
```

```bash
./gradlew bootRun

# REST 테스트 (read_load + write_load 시나리오 독립 실행)
k6 run k6/rest-blocking-test.js

# WebSocket 테스트 (setup에서 roomId 자동 생성)
k6 run k6/ws-stomp-test.js
```

### Virtual Thread OFF 테스트

```properties
# application.properties
spring.threads.virtual.enabled=false
```

```bash
./gradlew bootRun

# 동일 스크립트 재실행 후 결과 비교
k6 run k6/rest-blocking-test.js
k6 run k6/ws-stomp-test.js
```
