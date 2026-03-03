# Virtual Thread 도입 효과 검증 보고서
## WebSocket 1-on-1 채팅 기반 성능 테스트

---

## 1. 배경 및 목표

### Virtual Thread란

Java 21에서 정식 도입된 Virtual Thread는 JVM이 관리하는 경량 스레드다.
기존 **Platform Thread**(OS 스레드 1:1 매핑)와 달리, 수십만 개를 생성해도 메모리·CPU 오버헤드가 거의 없다.

핵심 동작 원리는 다음과 같다.

```
Platform Thread (기존)
────────────────────────────────────────
Thread-1 [    작업    ][  blocking  ][    작업    ]
                          ↑
                  OS 스레드를 점유한 채 대기
                  → 다른 요청 처리 불가

Virtual Thread (Java 21)
────────────────────────────────────────
VT-1     [    작업    ][ mount 해제 ][    작업    ]
                          ↑
                  blocking 순간 carrier thread 반환
                  → carrier thread가 VT-2, VT-3 처리
VT-2                 [    작업    ][  blocking  ] ...
VT-3                          [    작업    ] ...
```

즉, **blocking I/O가 많을수록 Virtual Thread의 이점이 커진다.**

### 프로젝트 목표

WebSocket 기반 1-on-1 채팅 서버에서 동시 사용자가 증가할 때,
Virtual Thread 도입이 **처리량(throughput)**과 **응답 지연(latency)** 에 미치는 영향을 측정한다.

---

## 2. 변경 전 상태와 문제점

### 2-1. `spring.threads.virtual.enabled=true`가 바꾸는 범위

Spring Boot 3.2+에서 이 설정이 적용되는 대상은 **Tomcat HTTP 스레드 풀**뿐이다.

```
HTTP 요청 흐름
클라이언트 ──→ Tomcat 스레드 ──→ RoomRestController
                    ↑
          이 스레드만 Virtual Thread로 전환됨 ✅

WebSocket STOMP 메시지 흐름
클라이언트 ──→ WebSocket 연결 ──→ STOMP Broker ──→ clientInboundChannel Executor ──→ ChatMessageController
                                                              ↑
                                              별도 ThreadPoolTaskExecutor (기본값: platform thread)
                                              spring.threads.virtual.enabled=true 미적용 ❌
```

결론: 설정을 켜놔도 **채팅 메시지를 처리하는 핵심 경로는 여전히 platform thread**로 동작하고 있었다.

### 2-2. WebSocket 핸들러에 blocking I/O 부재

`ChatMessageController`의 `joinRoom`, `sendMessage` 핸들러에 아무런 지연이 없었다.
Virtual Thread의 이점은 **blocking 중 carrier thread를 반환하는 것**인데,
blocking이 없으면 Virtual Thread와 platform thread의 동작 차이가 나타나지 않는다.

```java
// 변경 전: blocking 없음 → Virtual Thread 이점 측정 불가
@MessageMapping("/room.send")
public void sendMessage(@Payload ChatMessage message) {
    // 바로 처리 → 스레드를 반환할 기회 없음
    messaging.convertAndSend("/topic/room/" + message.getRoomId(), message);
}
```

### 2-3. 자동화된 부하 테스트 부재

수동으로 브라우저 UI를 클릭하는 방식은:
- 동시 사용자 수를 정밀하게 제어할 수 없다
- Virtual Thread ON/OFF 결과를 수치로 비교할 수 없다
- 재현 가능한 테스트가 아니다

---

## 3. 변경사항 상세

### 변경 1 — `WebSocketConfig.java`: STOMP 채널 executor를 Virtual Thread로 교체

#### 수정 내용

```java
// 변경 전: executor 설정 없음 → 기본 ThreadPoolTaskExecutor(platform thread) 사용
public class WebSocketConfig implements WebSocketMessageBrokerConfigurer {
    // configureClientInboundChannel 없음
    // configureClientOutboundChannel 없음
}

// 변경 후: property 하나로 ON/OFF 토글 가능
@Value("${spring.threads.virtual.enabled:false}")
private boolean virtualThreadEnabled;

@Override
public void configureClientInboundChannel(ChannelRegistration registration) {
    if (virtualThreadEnabled) {
        registration.executor(new VirtualThreadTaskExecutor("stomp-inbound-"));
    }
}

@Override
public void configureClientOutboundChannel(ChannelRegistration registration) {
    if (virtualThreadEnabled) {
        registration.executor(new VirtualThreadTaskExecutor("stomp-outbound-"));
    }
}
```

#### 왜 이렇게 수정했나

**`configureClientInboundChannel`**
클라이언트가 서버로 보내는 STOMP 메시지(`@MessageMapping` 핸들러)가 실행되는 스레드 풀이다.
여기가 Virtual Thread로 바뀌어야 `joinRoom`, `sendMessage` 핸들러 안의 blocking이 효과를 발휘한다.

**`configureClientOutboundChannel`**
서버가 구독자에게 메시지를 전달하는 스레드 풀이다.
구독자가 많아질수록 outbound 전송이 동시에 일어나는데, 각 전달 작업이 Virtual Thread에서 실행되면 채널 포화를 방지한다.

**`@Value` 조건부 분기**
`spring.threads.virtual.enabled` 프로퍼티 하나로 Tomcat(HTTP)과 STOMP 채널 양쪽을 동시에 ON/OFF할 수 있게 해서, **단일 설정 변경으로 완전한 ON/OFF 비교**가 가능하다.

#### 이전 vs 이후

| 항목 | 변경 전 | 변경 후 |
|------|---------|---------|
| HTTP 핸들러 | Virtual Thread | Virtual Thread |
| STOMP inbound 핸들러 | Platform Thread (기본 풀) | Virtual Thread |
| STOMP outbound 전달 | Platform Thread (기본 풀) | Virtual Thread |
| ON/OFF 토글 | 불완전 (HTTP만 바뀜) | 단일 property로 완전 제어 |

---

### 변경 2 — `ChatMessageController.java`: blocking I/O 시뮬레이션 추가

#### 수정 내용

```java
// joinRoom: DB에서 방 참여 가능 여부 조회 시뮬레이션 (50ms)
@MessageMapping("/room.join")
public void joinRoom(@Payload JoinRoomPayload payload, ...) {
    simulateDbRead();   // ← 추가
    // 기존 로직
}

// sendMessage: 메시지를 DB에 저장하는 시뮬레이션 (100ms)
@MessageMapping("/room.send")
public void sendMessage(@Payload ChatMessage message) {
    simulateDbWrite();  // ← 추가
    // 기존 로직
}

private void simulateDbRead()  { Thread.sleep(50);  }
private void simulateDbWrite() { Thread.sleep(100); }
```

#### 왜 이렇게 수정했나

실제 채팅 서버는 메시지 전송 시 DB에 저장(100ms 수준)하고, 입장 시 인증·인가 조회(50ms 수준)를 한다.
이 latency가 없으면 스레드가 즉시 반환되므로 스레드 풀 고갈 현상이 발생하지 않고,
결과적으로 **Virtual Thread와 platform thread 사이에 처리량 차이가 드러나지 않는다.**

`Thread.sleep()`은 blocking I/O의 대표적인 대안이다.
실제 DB 호출과 동일하게 해당 시간 동안 스레드를 점유하므로,
Virtual Thread 환경에서는 sleep 중 carrier thread를 반환하고,
platform thread 환경에서는 sleep 동안 스레드를 낭비하는 차이가 정확히 재현된다.

#### Virtual Thread ON/OFF에서 실제 동작 차이

```
[Platform Thread 환경 — 200 VU 동시 메시지 전송]

STOMP inbound 기본 풀 (core: 1, max: 1 또는 소수)
VT 없음 → thread-1이 100ms 동안 점유
            → thread-2가 100ms 동안 점유
            → thread-3 대기... thread-4 대기... (큐 적체)

결과: 처리량 낮음, latency 급증

────────────────────────────────────────────────

[Virtual Thread 환경 — 200 VU 동시 메시지 전송]

carrier thread-1
  ├─ VT-1 실행 → sleep(100ms) → carrier 반환 → VT-2 실행 → sleep → 반환 → ...
  └─ 100ms 내에 수십 개 Virtual Thread 교대로 실행

결과: 처리량 유지, latency 안정
```

---

### 변경 3 — `load-test/`: k6 부하 테스트 스크립트 추가

#### 구성

```
k6/
├── rest-load-test.js   # HTTP REST 엔드포인트 부하 테스트
└── ws-load-test.js     # WebSocket STOMP 메시지 부하 테스트
```

#### `rest-load-test.js` 설계 의도

```
VU 수: 10 → 100 → 300 (Tomcat 기본 풀 200개 초과 구간 포함)

측정 지표:
  - get_rooms_duration  p95: GET /api/rooms (50ms blocking)
  - create_room_duration p95: POST /api/rooms (100ms blocking)
  - errors rate

임계값:
  - p(95) < 300ms   → Virtual Thread ON이면 300 VU에서도 통과
  - errors < 5%
```

VU가 Tomcat 기본 스레드 수(200)를 넘어가는 구간에서 차이가 발생한다.
Virtual Thread ON: 모든 요청이 독립 Virtual Thread에서 처리되어 latency 유지
Virtual Thread OFF: 스레드 풀 포화 → 요청이 큐에서 대기 → latency 급증

#### `ws-load-test.js` 설계 의도

```
VU 수: 10 → 200

SockJS + STOMP 프로토콜 시퀀스:
  1. SockJS WebSocket 연결
  2. STOMP CONNECT 전송
  3. 방 구독 (SUBSCRIBE)
  4. 방 입장 (room.join → 50ms blocking)
  5. 메시지 전송 (room.send → 100ms blocking)
  6. 브로드캐스트 수신까지 RTT 측정

측정 지표:
  - ws_e2e_latency_ms: 메시지 전송 → 수신까지 왕복 시간
  - ws_connect_success rate
  - ws_messages_sent / ws_messages_received
```

HTTP 테스트와 달리 WebSocket은 연결이 유지되는 동안 여러 메시지를 주고받는다.
STOMP inbound channel이 Virtual Thread인 경우, 각 메시지 처리가 독립 Virtual Thread에서 실행되므로
동시 메시지 수가 증가해도 e2e latency가 선형적으로 증가하지 않는다.

---

## 4. 기대 비교 결과

### REST 엔드포인트 (GET /api/rooms, 50ms blocking)

| VU 수 | Virtual Thread OFF (p95) | Virtual Thread ON (p95) |
|-------|--------------------------|-------------------------|
| 50    | ~55ms                    | ~55ms                   |
| 100   | ~60ms                    | ~55ms                   |
| 200   | ~200ms (풀 포화 시작)    | ~55ms                   |
| 300   | ~500ms+ (큐 적체)        | ~60ms                   |

### WebSocket 메시지 RTT (sendMessage, 100ms blocking)

| 동시 연결 수 | Virtual Thread OFF (p95 RTT) | Virtual Thread ON (p95 RTT) |
|-------------|------------------------------|-----------------------------|
| 50          | ~110ms                       | ~110ms                      |
| 100         | ~300ms                       | ~115ms                      |
| 200         | ~800ms+                      | ~120ms                      |

> 수치는 환경에 따라 다를 수 있으며, 핵심은 **VU 증가에 따른 기울기 차이**다.

---

## 5. 테스트 실행 가이드

### 환경 준비

```bash
# k6 설치 (macOS)
brew install k6
```

### Virtual Thread ON 테스트

```properties
# application.properties
spring.threads.virtual.enabled=true
```

```bash
./gradlew bootRun

# 터미널 2 — REST 테스트
k6 run k6/rest-load-test.js

# 터미널 2 — WebSocket 테스트 (roomId 교체 필요)
# 1. curl로 방 생성
curl -X POST http://localhost:8080/api/rooms \
     -H 'Content-Type: application/json' \
     -d '{"roomName":"load-test-room","creatorId":"admin"}'
# 2. 응답의 roomId를 ws-load-test.js의 ROOM_ID 변수에 입력
k6 run k6/ws-load-test.js
```

### Virtual Thread OFF 테스트 (비교 기준)

```properties
# application.properties
spring.threads.virtual.enabled=false
```

```bash
./gradlew bootRun

# 동일한 k6 스크립트 재실행 후 결과 비교
k6 run k6/rest-load-test.js
k6 run k6/ws-load-test.js
```

### 핀닝(Pinning) 확인

```bash
# build.gradle에 이미 설정됨
# -Djdk.tracePinnedThreads=full

./gradlew bootRun
# synchronized 블록에서 Virtual Thread가 carrier thread를 반환 못하면 로그 출력됨
# 현재 코드는 ReentrantLock 사용이므로 핀닝 없음
```

---

## 6. 주요 설계 결정 요약

| 결정 | 이유 |
|------|------|
| `configureClientInboundChannel` 추가 | `spring.threads.virtual.enabled`가 STOMP 채널을 바꾸지 않기 때문 |
| `@Value` 조건부 분기 | property 하나로 HTTP + WebSocket 동시 ON/OFF → 공정한 비교 |
| `joinRoom` 50ms sleep | 실제 서버의 입장 가능 여부 DB 조회 latency 반영 |
| `sendMessage` 100ms sleep | 실제 서버의 메시지 저장 latency 반영 |
| `ReentrantLock` 유지 | `synchronized`는 Virtual Thread 핀닝 유발, `ReentrantLock`은 안전 |
| k6 SockJS 직접 구현 | k6가 SockJS를 기본 지원하지 않으므로 프레임 파싱을 직접 구현 |
| ramp-up 시나리오 | 풀 포화 임계점(HTTP 200, STOMP 기본값)을 자연스럽게 통과하도록 설계 |
