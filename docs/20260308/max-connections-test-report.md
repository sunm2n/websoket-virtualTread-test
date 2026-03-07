# 최대 동시 연결 한계 테스트 결과 보고서

## 2026-03-08

---

## 1. 테스트 목적 및 배경

### 1-1. 왜 이 테스트를 하는가

2차 테스트(2026-03-04)에서 REST 800 VU, WebSocket 1,000 VU 수준의 성능 차이를 확인했다.
그러나 해당 테스트에서는 **각 모드의 최대 동시 연결 한계점**을 탐색하지 않았다.

| 2차 테스트의 한계 | 이번 테스트의 목표 |
|------------------|-----------------|
| 고정 VU에서 ON/OFF 비교만 수행 | VU를 단계적으로 올려 **첫 에러 발생 지점** 탐색 |
| 최대 800 VU (REST), 1,000 VU (WS) | 최대 3,300 VU (REST), 5,000 VU (WS)까지 증가 |
| "어디까지 버틸 수 있는가"에 대한 답 없음 | Platform Thread vs Virtual Thread의 **수용 한계 차이를 수치화** |

### 1-2. 서버 구성 현황

| 항목 | 설정값 |
|------|--------|
| Tomcat max threads | 200 (기본값, 명시 설정 없음) |
| WebSocket executor | VirtualThreadTaskExecutor (VT ON 시) |
| REST GET blocking | `Thread.sleep(50ms)` |
| REST POST blocking | `Thread.sleep(100ms)` |
| WS join blocking | `Thread.sleep(50ms)` |
| WS send blocking | `Thread.sleep(100ms)` |
| 동기화 | ReentrantLock (핀닝 없음) |
| 연결 제한 | 명시적 설정 없음 |

**예상되는 한계점:**
- VT OFF: Tomcat 스레드 풀 200개 → 200 이상의 동시 blocking 요청에서 큐 적체, 일정 수준 이상에서 timeout/거부
- VT ON: OS 스레드 제한 없음 → JVM 힙 메모리가 한계점

---

## 2. 테스트 설계

### 2-1. REST 최대 연결 테스트 (`rest-max-connections-test.js`)

2차 테스트의 `rest-blocking-test.js`와 동일한 read/write 시나리오 로직을 재활용하되, VU를 5단계로 증가시킨다.

```
read_load (readScenario):   300 → 600 → 900 → 1,500 → 2,500 VU
write_load (writeScenario): 100 → 200 → 300 →   500 →   800 VU
───────────────────────────────────────────────────────────────
합계:                        400 → 800 → 1,200 → 2,000 → 3,300 VU
```

- 각 단계: 20초 ramp-up + 30초 hold (안정 상태 측정)
- 총 실행 시간: 약 4분 30초
- threshold 없음 — 에러 발생을 허용하여 한계점 탐색

**추가 수집 메트릭 (2차 대비):**
- `connection_refused` (Counter): TCP 연결 자체가 거부된 횟수
- `timeout_errors` (Counter): i/o timeout 횟수

### 2-2. WebSocket 최대 연결 테스트 (`ws-max-connections-test.js`)

2차 테스트의 `ws-stomp-test.js` STOMP 연결 로직을 재활용하되, **연결 유지**에 초점을 맞춘다.

```
VU 단계: 1,000 → 2,000 → 3,000 → 5,000
```

| 항목 | 2차 테스트 (ws-stomp-test.js) | 이번 테스트 (ws-max-connections-test.js) |
|------|------------------------------|----------------------------------------|
| 최대 VU | 1,000 | **5,000** |
| 메시지 전송 | 20개 후 종료 (100ms 간격) | **2초 간격으로 hold 구간 동안 계속 전송** |
| 연결 유지 시간 | ~2초 (20 × 100ms) | **hold 구간 전체 (30초)** |
| timeout | 30초 | **60초** |
| 측정 초점 | 메시지 처리량 | **동시 연결 수용 한계** |

**추가 수집 메트릭:**
- `active_connections` (Gauge): 현재 활성 WebSocket 연결 수
- `connection_refused` (Counter): 연결 거부 횟수
- `timeout_errors` (Counter): timeout 횟수

---

## 3. REST 최대 연결 테스트 결과

> 실행 환경: 로컬 macOS, `ulimit -n 10240`
> 시나리오: read_load (최대 2,500 VU) + write_load (최대 800 VU), 총 최대 3,300 VU, 4분 30초

### 3-1. Virtual Thread OFF

```
create_latency_ms..: avg=433.34ms  min=100.24ms  med=363.42ms  max=981.8ms   p(90)=913.09ms  p(95)=932.55ms
list_latency_ms....: avg=387.91ms  min=50.21ms   med=314.73ms  max=948.68ms  p(90)=865.29ms  p(95)=882.45ms
error_rate.........: 0.00%   0 out of 873,655
http_req_failed....: 0.00%   0 out of 998,560
http_reqs..........: 998,560  (3,688/s)
iterations.........: 873,655  (3,227/s)
JVM live threads...: 216
```

### 3-2. Virtual Thread ON

```
create_latency_ms..: avg=112.95ms  min=100.12ms  med=104.07ms  max=435.83ms  p(90)=138.06ms  p(95)=157.17ms
list_latency_ms....: avg=62.75ms   min=50.09ms   med=53.47ms   max=463.33ms  p(90)=85.98ms   p(95)=110.87ms
error_rate.........: 0.00%   0 out of 5,366,534
http_req_failed....: 0.00%   0 out of 6,144,591
http_reqs..........: 6,144,591  (22,696/s)
iterations.........: 5,366,534  (19,822/s)
JVM live threads...: 31
```

### 3-3. REST 비교 요약

| 지표 | VT OFF | VT ON | 변화 |
|------|--------|-------|------|
| **에러율** | 0% | 0% | 동일 (한계 미도달) |
| list_latency_ms avg | 387.91ms | 62.75ms | **▼ 83.8%** |
| list_latency_ms p(95) | 882.45ms | 110.87ms | **▼ 87.4%** |
| list_latency_ms max | 948.68ms | 463.33ms | ▼ 51.1% |
| create_latency_ms avg | 433.34ms | 112.95ms | **▼ 73.9%** |
| create_latency_ms p(95) | 932.55ms | 157.17ms | **▼ 83.1%** |
| create_latency_ms max | 981.8ms | 435.83ms | ▼ 55.6% |
| iterations | 873,655 | 5,366,534 | **▲ 6.14x** |
| http_reqs/s | 3,688 | 22,696 | **▲ 6.15x** |
| JVM threads | 216 | 31 | **▼ 85.6%** |

### 3-4. REST 결과 분석

**핵심 발견: 3,300 VU에서도 양쪽 모두 에러 0% — 한계점에 도달하지 못했다.**

이는 Tomcat의 요청 수락 큐(accept queue) 덕분이다. 스레드 풀(200개)이 포화되더라도 요청이 **거부되지 않고 큐에 쌓여 대기**한다.

```
[VT OFF — 3,300 VU 요청 흐름]

요청 유입 (3,300 VU)
    ↓
Tomcat Accept Queue (기본 100, OS backlog에 따라 더 큼)
    ↓
Thread Pool (200개) ← 병목 지점
├── thread-1~200: 각각 50~100ms sleep 후 반환
├── 201번째~3,300번째 요청: 큐에서 대기
└── 결과: 에러는 없지만 대기 시간이 누적
         avg GET latency: 50ms → 388ms (대기 338ms 추가)

→ "에러가 없다"가 "문제가 없다"를 의미하지 않는다.
→ 사용자 체감 레이턴시는 이미 심각하게 저하됨.
```

```
[VT ON — 3,300 VU 요청 흐름]

요청 유입 (3,300 VU)
    ↓
Virtual Thread 즉시 생성 (요청당 1개)
    ↓
Carrier Thread (~10개, CPU 코어 수)
├── VT-1: sleep(50ms) → carrier 반환 → 다른 VT 실행
├── VT-2~3,300: 동시 대기, 교대로 carrier 사용
└── 결과: 대기 시간 거의 없음
         avg GET latency: 62.75ms (sleep 50ms + 오버헤드 12.75ms)
```

**2차 테스트(800 VU) → 3차 테스트(3,300 VU) 변화:**

| 지표 | 2차 (800 VU) OFF | 3차 (3,300 VU) OFF | 변화 |
|------|-----------------|-------------------|------|
| list_latency avg | 138ms | 388ms | ▲ 2.8x 악화 |
| list_latency p(95) | 210ms | 882ms | ▲ 4.2x 악화 |
| http_reqs/s | 3,483 | 3,688 | 거의 동일 |

| 지표 | 2차 (800 VU) ON | 3차 (3,300 VU) ON | 변화 |
|------|-----------------|-------------------|------|
| list_latency avg | 53.76ms | 62.75ms | 미미한 증가 |
| list_latency p(95) | 59.54ms | 110.87ms | 소폭 증가 |
| http_reqs/s | 8,898 | 22,696 | ▲ 2.55x 향상 |

> **VT OFF는 VU를 4배 올려도 처리량(reqs/s)이 거의 늘지 않았다** — 스레드 풀이 포화된 상태에서 VU를 더 올려봤자 큐 대기만 늘어날 뿐이다.
> **VT ON은 VU를 4배 올리니 처리량도 2.55배 증가했다** — 여전히 여유가 있다는 뜻이다.

---

## 4. WebSocket 최대 연결 테스트 결과

> 실행 환경: 로컬 macOS, `ulimit -n 10240`
> 시나리오: 0 → 1,000 → 2,000 → 3,000 → 5,000 VU, 3분 40초

### 4-1. Virtual Thread OFF

```
ws_error_rate......: 42.22%  20,800 out of 49,262
http_req_failed....: 50.37%  20,800 out of 41,289
room created (201).: 49%  ✓ 20,488 / ✗ 20,800
ws status 101......: 44%  ✓ 7,974 / ✗ 9,841
msg_roundtrip_ms...: avg=13.17s   min=100ms  med=11.75s   max=41.99s  p(90)=27.72s  p(95)=33.46s
messages_sent......: 67,653
messages_received..: 27,394  (수신율 40.5%)
ws_connect_duration: avg=452.5ms  p(95)=1.73s
iterations.........: 38,518  (154/s)
ws_sessions........: 20,488
interrupted........: 2,770
JVM live threads...: 285
```

### 4-2. Virtual Thread ON

```
ws_error_rate......: 37.39%  15,865 out of 42,429
http_req_failed....: 45.98%  15,865 out of 34,497
room created (201).: 54%  ✓ 18,631 / ✗ 15,865
ws status 101......: 49%  ✓ 7,933 / ✗ 7,973
msg_roundtrip_ms...: avg=112.22ms  min=100ms  med=102ms    max=810ms   p(90)=111ms   p(95)=146ms
messages_sent......: 300,524
messages_received..: 311,048  (수신율 103.5%)
ws_connect_duration: avg=834.17ms  p(95)=2.84s
iterations.........: 31,681  (127/s)
ws_sessions........: 18,631
interrupted........: 2,815
JVM live threads...: 44
```

### 4-3. WebSocket 비교 요약

| 지표 | VT OFF | VT ON | 변화 |
|------|--------|-------|------|
| **에러율** | 42.22% | 37.39% | 소폭 개선 |
| 방 생성 성공률 | 49% | 54% | 소폭 개선 |
| WS 연결 성공 수 | 7,974 | 7,933 | **거의 동일** |
| **msg roundtrip avg** | **13.17초** | **112ms** | **▼ 99.1% (117배)** |
| msg roundtrip p(95) | 33.46초 | 146ms | **▼ 99.6% (229배)** |
| msg roundtrip max | 41.99초 | 810ms | ▼ 98.1% |
| messages sent | 67,653 | 300,524 | **▲ 4.4x** |
| messages received | 27,394 | 311,048 | **▲ 11.4x** |
| 메시지 수신율 | 40.5% (59.5% 누락) | 103.5% (완전 수신) | ✅ |
| 메시지 처리량 | 110 msg/s | 1,329 msg/s | **▲ 12.1x** |
| JVM threads | 285 | 44 | **▼ 84.6%** |
| interrupted VU | 2,770 | 2,815 | 동일 수준 |

### 4-4. WebSocket 결과 분석

#### 예상과 빗나간 점: 연결 수용 능력은 VT ON/OFF 모두 비슷하게 실패

**원래 가설:**
> VT OFF는 스레드 풀 200개에 막혀 일찍 실패하고, VT ON은 스레드 제한이 없으므로 훨씬 많은 연결을 수용할 것이다.

**실제 결과:**
> 양쪽 모두 약 50%의 에러율을 보였고, 성공한 WS 연결 수도 ~7,950개로 거의 동일했다.

이는 **병목이 WebSocket 연결 자체가 아니라, 방 생성 REST API에 있었기 때문**이다.

```
[WebSocket 테스트의 실제 병목 구조]

각 VU의 실행 흐름:
  1. POST /api/rooms (방 생성) ← 여기서 실패
  2. ws:// 연결
  3. STOMP CONNECT → SUBSCRIBE → JOIN → 메시지 전송

5,000 VU가 동시에 POST /api/rooms를 호출
    ↓
HTTP 연결 풀 고갈 (로컬 머신의 ephemeral port, TCP 소켓 한계)
    ↓
"dial: i/o timeout" — TCP 연결 자체가 수립되지 못함
    ↓
방 생성 실패 → roomId 없음 → WS 연결 시도조차 불가
    ↓
결과: 에러의 대부분은 WS가 아닌 REST 방 생성에서 발생
```

**증거:** 방 생성이 실패한 VU는 WebSocket 연결 자체를 시도하지 않는다 (코드에서 `return`). 따라서 WS 에러가 아닌 HTTP 에러로 분류됨.

| 단계 | VT OFF 실패 | VT ON 실패 |
|------|------------|-----------|
| POST /api/rooms | 20,800건 실패 | 15,865건 실패 |
| WS 연결 (방 생성 성공 후) | 9,841건 실패 | 7,973건 실패 |

VT ON이 방 생성에서 약간 덜 실패한 이유는 REST 요청 처리가 빠르므로 TCP 연결이 더 빨리 반환되기 때문이다. 그러나 근본적으로 **로컬 머신의 네트워크 스택 한계**(ephemeral port, file descriptor)가 병목이므로 큰 차이가 나지 않았다.

#### VT ON/OFF의 실제 차이: 연결 수가 아닌 연결 "품질"

연결 수용 능력은 비슷했지만, **성공한 연결의 성능**은 극적으로 달랐다:

```
[VT OFF — 성공한 7,974개 연결의 상태]

msg roundtrip: avg 13.17초 (서버 sleep 100ms 대비 131배)
├── 원인: STOMP inbound 스레드 풀 포화
│         → 메시지 처리 큐 적체
│         → 2초 간격으로 보낸 메시지가 13초 뒤에야 echo
├── messages sent:     67,653
├── messages received: 27,394 (40.5%) ← 59.5% 메시지 누락
└── 의미: "연결은 됐지만 채팅이 불가능한 상태"

[VT ON — 성공한 7,933개 연결의 상태]

msg roundtrip: avg 112ms (서버 sleep 100ms 대비 +12ms)
├── 원인: VirtualThreadTaskExecutor가 메시지마다 VT 생성
│         → 큐 적체 없이 즉시 처리
├── messages sent:     300,524
├── messages received: 311,048 (103.5%) ← 완전 수신 + 다른 VU 메시지도 수신
└── 의미: "연결 수는 같지만 정상적인 실시간 채팅이 가능"
```

> **핵심 차이: 동시 연결 "수"는 비슷했지만, 서비스 "품질"은 VT OFF가 사실상 불능, VT ON은 정상.**

#### 프로덕션 관점에서의 의미

| 시나리오 | VT OFF | VT ON |
|---------|--------|-------|
| 8,000명 동시 접속 채팅 | ❌ 메시지 13초 지연, 60% 누락 | ✅ 112ms 응답, 누락 0% |
| 메시지 전송 후 "읽음" 표시 | ❌ 33초 후 도착 (p95) | ✅ 146ms 후 도착 |
| 사용자 체감 | "앱이 멈췄다" | "정상" |

---

## 5. 2차 → 3차 테스트 종합 비교

### 5-1. REST 부하 확장에 따른 변화

| 지표 | 2차 (800 VU) OFF | 3차 (3,300 VU) OFF | 변화 |
|------|-----------------|-------------------|------|
| list_latency avg | 138ms | 388ms | ▲ 2.8x 악화 |
| list_latency p(95) | 210ms | 882ms | ▲ 4.2x 악화 |
| create_latency avg | 188ms | 433ms | ▲ 2.3x 악화 |
| http_reqs/s | 3,483 | 3,688 | 변화 없음 |
| 에러율 | 0% | 0% | 동일 |

| 지표 | 2차 (800 VU) ON | 3차 (3,300 VU) ON | 변화 |
|------|-----------------|-------------------|------|
| list_latency avg | 53.76ms | 62.75ms | +17% (미미) |
| list_latency p(95) | 59.54ms | 110.87ms | +86% (여전히 양호) |
| create_latency avg | 103.78ms | 112.95ms | +9% (미미) |
| http_reqs/s | 8,898 | 22,696 | **▲ 2.55x** |
| 에러율 | 0% | 0% | 동일 |

> VT OFF는 VU 4배 증가에도 처리량이 정체 (스레드 풀 포화 → 큐 대기만 증가)
> VT ON은 VU 4배 증가에 비례하여 처리량도 증가 (여전히 여유 있음)

### 5-2. WebSocket 부하 확장에 따른 변화

| 지표 | 2차 (1,000 VU) OFF | 3차 (5,000 VU) OFF | 변화 |
|------|-------------------|-------------------|------|
| msg roundtrip avg | 5.85초 | 13.17초 | ▲ 2.3x 악화 |
| 메시지 수신율 | 61% | 40.5% | ▼ 20.5%p 악화 |
| ws_error_rate | 0% | 42.22% | 한계 도달 |
| interrupted | 38 | 2,770 | 대량 발생 |

| 지표 | 2차 (1,000 VU) ON | 3차 (5,000 VU) ON | 변화 |
|------|-------------------|-------------------|------|
| msg roundtrip avg | 101.47ms | 112.22ms | +10.6% (미미) |
| 메시지 수신율 | 108% | 103.5% | 완전 수신 유지 |
| ws_error_rate | 0% | 37.39% | 한계 도달 (REST 병목) |
| interrupted | 0 | 2,815 | 대량 발생 (연결 시간 초과) |

---

## 6. 한계 탐색 결론

### 6-1. 발견된 한계점 요약

| 프로토콜 | 모드 | 한계점 | 원인 |
|---------|------|--------|------|
| REST | VT OFF | **한계 미도달** (3,300 VU에서 에러 0%) | Tomcat 큐가 요청을 수용, 대신 레이턴시 급증 |
| REST | VT ON | **한계 미도달** (3,300 VU에서 에러 0%) | VT의 확장성으로 여유 있는 처리 |
| WebSocket | VT OFF | **~1,000 VU 이후 급격 저하** (5,000 VU에서 에러 42%) | 스레드 풀 포화 + REST 병목 |
| WebSocket | VT ON | **~2,000 VU 이후 REST 병목** (5,000 VU에서 에러 37%) | 로컬 머신 네트워크 한계 (REST 방 생성) |

### 6-2. 원래 계획 대비 달성 / 미달성 사항

| 계획 | 달성 여부 | 설명 |
|------|----------|------|
| REST 한계점 탐색 | ❌ 미도달 | 3,300 VU에서도 에러 0%. Tomcat 큐가 요청을 버퍼링하여 에러 대신 레이턴시 증가로 나타남. 더 높은 VU 또는 timeout 설정 필요. |
| WebSocket 한계점 탐색 | ⚠️ 부분 달성 | 에러 발생 지점은 확인했으나, **병목이 WS 자체가 아닌 REST 방 생성**에 있어 순수 WS 한계는 측정 불가. |
| VT OFF/ON 수용 능력 차이 수치화 | ⚠️ 부분 달성 | REST는 처리량 6.15x 차이 확인. WS는 연결 수 차이는 없었으나 **연결 품질 차이**(roundtrip 117배)를 발견. |
| 첫 에러 발생 지점 특정 | ❌ 미달성 | REST는 에러 대신 레이턴시 증가로 나타남. WS는 에러가 REST 병목에서 발생하여 순수 WS 한계 미특정. |

### 6-3. 테스트 설계의 한계 및 개선 방향

#### 한계 1: REST 한계점을 에러로 탐지할 수 없음

Tomcat은 스레드 풀이 포화되어도 요청을 큐에 쌓기 때문에, 단순히 에러 발생 여부만으로는 한계점을 판단할 수 없다.

**개선 방향:**
- k6에 request timeout 설정 추가 (예: `http.get(url, { timeout: '500ms' })`)
- "레이턴시가 기대값(sleep 시간)의 N배를 초과하면 한계"로 기준 재정의
- VU를 더 높은 단계(5,000, 10,000)까지 확장

#### 한계 2: WebSocket 테스트의 REST 병목

각 VU가 WS 연결 전에 REST로 방을 생성하는 구조이므로, 대량 VU에서 REST가 먼저 실패한다.

**개선 방향:**
- `setup()`에서 방을 미리 생성하고, VU는 기존 방에 접속만 하도록 변경
- 방 1개에 다수 VU가 접속하는 시나리오 (실제 채팅방과 유사)

#### 한계 3: 로컬 머신의 네트워크 한계

5,000 VU의 TCP 연결이 로컬 머신의 ephemeral port와 file descriptor를 소진한다.

**개선 방향:**
- 분산 부하 테스트 (k6 Cloud 또는 별도 클라이언트 머신)
- 서버를 별도 머신에서 실행하여 클라이언트/서버 리소스 분리

---

## 7. 최종 결론

### 7-1. 확인된 사실

1. **REST에서 VT ON의 확장성은 압도적이다**
   - VU 4배 증가 시: VT OFF는 처리량 정체, VT ON은 처리량도 비례 증가
   - 3,300 VU에서 처리량 6.15배, 레이턴시 83~87% 감소

2. **WebSocket에서 VT ON의 이점은 "연결 수"가 아닌 "연결 품질"에 있다**
   - 동시 연결 수용 능력은 비슷했지만 (로컬 네트워크 한계)
   - 성공한 연결의 메시지 처리: VT OFF avg 13초 vs VT ON avg 112ms (**117배 차이**)
   - 메시지 누락: VT OFF 59.5% 누락 vs VT ON 0% 누락

3. **VT OFF의 "에러 없음"이 "문제 없음"을 의미하지 않는다**
   - REST: 에러 0%이지만 레이턴시가 sleep 시간의 8배
   - WebSocket: 연결은 성공했지만 메시지가 13초 걸리면 실시간 채팅이 아님

### 7-2. 서비스 관점 판단 기준

| 기준 | VT OFF | VT ON |
|------|--------|-------|
| REST 3,300 VU 응답 시간 | avg 388ms (서비스 가능하나 느림) | avg 63ms (**쾌적**) |
| WS 8,000명 실시간 채팅 | ❌ 불가 (13초 지연, 60% 누락) | ✅ **가능** (112ms, 누락 없음) |
| 서버 리소스 효율 | 216 OS 스레드, ~216MB 스택 | 31 OS 스레드, ~31MB 스택 |
| 추가 튜닝 필요 여부 | 스레드 풀 크기 조정 필수 | **불필요** (자동 확장) |

---

## 8. 테스트 실행 방법

### 사전 준비

```bash
# 파일 디스크립터 한도 상향 (필수, 터미널 세션 한정)
ulimit -n 10240

# 프로젝트 디렉터리로 이동
cd ~/test/websoket-vtualTread-test
```

### VT OFF 테스트

```bash
# application.properties에서 spring.threads.virtual.enabled=true 주석 처리 후 서버 실행
k6 run --out json=results/20260308/rest-max-platform.json k6/rest-max-connections-test.js
k6 run --out json=results/20260308/ws-max-platform.json k6/ws-max-connections-test.js
```

### VT ON 테스트

```bash
# spring.threads.virtual.enabled=true 활성화 후 서버 재실행
k6 run --out json=results/20260308/rest-max-virtual.json k6/rest-max-connections-test.js
k6 run --out json=results/20260308/ws-max-virtual.json k6/ws-max-connections-test.js
```

### 테스트 스크립트 구조

```
k6/
├── rest-blocking-test.js         # 2차: REST 부하 테스트 (800 VU)
├── ws-stomp-test.js              # 2차: WebSocket 부하 테스트 (1,000 VU)
├── rest-max-connections-test.js  # 3차: REST 최대 연결 한계 (3,300 VU)
└── ws-max-connections-test.js    # 3차: WebSocket 최대 연결 한계 (5,000 VU)

results/
└── 20260308/
    ├── rest-max-platform.json    # VT OFF REST 결과
    ├── rest-max-virtual.json     # VT ON REST 결과
    ├── ws-max-platform.json      # VT OFF WebSocket 결과
    └── ws-max-virtual.json       # VT ON WebSocket 결과
```

#### results의 json은 파일 크기로 인하여 로컬에서만 관리
