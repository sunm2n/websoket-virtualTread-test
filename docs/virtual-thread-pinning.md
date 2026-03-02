# Java 21 가상 쓰레드 Pinning 현상 분석 및 해결

## 목차

1. [배경 — 가상 쓰레드란 무엇인가](#1-배경--가상-쓰레드란-무엇인가)
2. [Pinning이란 무엇인가](#2-pinning이란-무엇인가)
3. [왜 Pinning이 발생했는가 — 근본 원인 분석](#3-왜-pinning이-발생했는가--근본-원인-분석)
4. [이 프로젝트에서 Pinning이 발생한 지점](#4-이-프로젝트에서-pinning이-발생한-지점)
5. [해결책 1 — ReentrantLock 도입](#5-해결책-1--reentrantlock-도입)
6. [해결책 2 — Pinning 탐지 옵션 추가](#6-해결책-2--pinning-탐지-옵션-추가)
7. [적용 전후 비교](#7-적용-전후-비교)
8. [테스트 결과](#8-k6-run-k6ws-stomp-testjs-테스트-결과)

---

## 1. 배경 — 가상 쓰레드란 무엇인가

Java 21에서 정식 도입된 **가상 쓰레드(Virtual Thread)** 는 JVM이 직접 관리하는 경량 쓰레드다. OS 쓰레드와 1:1로 매핑되는 기존 플랫폼 쓰레드(Platform Thread)와 달리, 가상 쓰레드는 **M:N 모델**로 동작한다.

```
가상 쓰레드 (수천 ~ 수백만 개)
        │
        ▼
   ForkJoinPool (기본 스케줄러)
        │
        ▼
플랫폼 쓰레드 = Carrier Thread (CPU 코어 수 정도)
        │
        ▼
      OS Thread
```

가상 쓰레드의 핵심 동작 원리는 **mount / unmount** 다.

- **mount**: 가상 쓰레드가 실행될 때 carrier thread에 올라타 CPU를 사용한다.
- **unmount**: 가상 쓰레드가 I/O 대기 등 블로킹 상태에 진입하면 JVM이 해당 가상 쓰레드를 carrier thread에서 내려 다른 가상 쓰레드가 그 carrier를 사용하도록 양보한다.

이 unmount 메커니즘 덕분에 수천 개의 가상 쓰레드가 소수의 carrier thread로도 높은 처리량을 낼 수 있다.

Spring Boot에서는 `application.properties`에 아래 설정 한 줄로 활성화한다.

```properties
spring.threads.virtual.enabled=true
```

---

## 2. Pinning이란 무엇인가

**Pinning**은 가상 쓰레드가 carrier thread에서 unmount되지 못하고 **고착(固着)** 되는 현상이다.

가상 쓰레드가 pinned 상태가 되면:

1. 해당 carrier thread는 블로킹이 풀릴 때까지 다른 가상 쓰레드를 실행할 수 없다.
2. 사실상 그 carrier thread는 **플랫폼 쓰레드처럼 1:1로 점유**된다.
3. 동시에 pinning되는 가상 쓰레드 수가 많아질수록 carrier thread가 부족해져 전체 처리량이 급감한다.

```
[Pinning 발생 시]

가상 쓰레드 A ──(pin)──> Carrier Thread 1 ─ 블로킹 대기 중 (반환 불가)
가상 쓰레드 B ──(pin)──> Carrier Thread 2 ─ 블로킹 대기 중 (반환 불가)
가상 쓰레드 C ──(pin)──> Carrier Thread 3 ─ 블로킹 대기 중 (반환 불가)
가상 쓰레드 D ──(대기)──> carrier 없음 ─ 스케줄 불가 → 지연 폭증
```

JVM 명세(JEP 444)에 따르면 pinning을 유발하는 두 가지 조건이 있다.

| 조건 | 설명 |
|------|------|
| `synchronized` 블록/메서드 내에서 블로킹 | JVM이 intrinsic lock을 carrier thread에 묶어 unmount 불가 |
| native 메서드 / foreign function 내에서 블로킹 | JVM 스택 외부이므로 unmount 불가 |

---

## 3. 왜 Pinning이 발생했는가 — 근본 원인 분석

### 3-1. `synchronized`의 내부 동작

Java의 `synchronized`는 **객체의 intrinsic lock(모니터 락)** 을 사용한다. 이 락은 JVM 객체 헤더(mark word)에 기록되며, OS 수준의 mutex와 연동된다.

```
객체 헤더 (mark word)
┌─────────────────────────────────┐
│ thread_id │ epoch │ lock_state  │
└─────────────────────────────────┘
       ↑
 synchronized 진입 시 여기에 소유 쓰레드를 기록
```

JVM이 가상 쓰레드를 unmount하려면 해당 가상 쓰레드의 **스택 프레임 전체를 힙으로 이전**해야 한다. 그런데 가상 쓰레드가 `synchronized` 블록 안에 있으면, intrinsic lock의 소유권이 carrier thread의 OS 쓰레드 ID에 묶여 있어 스택을 힙으로 옮길 수 없다.

결과적으로 JVM은 **"이 가상 쓰레드는 내릴 수 없다"** 고 판단하여 carrier thread에 계속 고착시킨다.

### 3-2. Pinning 발생 흐름 (순서도)

```
가상 쓰레드 V1이 synchronized joinRoom() 진입
        │
        ▼
intrinsic lock 획득 → 객체 헤더에 Carrier-Thread-1의 OS ID 기록
        │
        ▼
joinRoom() 내부에서 I/O 또는 다른 블로킹 발생
        │
        ▼
JVM이 unmount 시도
        │
        ▼
 ┌─── intrinsic lock이 Carrier-Thread-1에 묶여 있음
 │         → 스택을 힙으로 이전 불가
 │         → unmount 거부
 └─── V1은 Carrier-Thread-1에 pin됨
        │
        ▼
다른 가상 쓰레드들이 Carrier-Thread-1을 사용하지 못하고 대기
        │
        ▼
부하가 클수록 carrier thread 고갈 → 처리량 급락
```

### 3-3. 왜 이 프로젝트에서 문제가 됐는가

이 프로젝트는 1000 VU(Virtual Users)의 WebSocket 부하 테스트 환경이다. 각 VU는 채팅방 생성 후 `joinRoom()`을 호출하는데:

- 1000개의 가상 쓰레드가 거의 동시에 `synchronized joinRoom()`에 진입을 시도한다.
- 락 경합(lock contention)이 발생하면 대기 중인 가상 쓰레드들이 차례로 pin된다.
- CPU 코어 수만큼밖에 없는 carrier thread가 pin된 쓰레드들로 잠식된다.
- 새로운 WebSocket 요청을 처리할 carrier thread가 부족해져 지연이 누적된다.

---

## 4. 이 프로젝트에서 Pinning이 발생한 지점

**파일:** `src/main/java/com/example/websoketvtualtreadtest/store/ChatRoomStore.java`

### 수정 전 코드 (AS-IS)

```java
// AS-IS: synchronized 키워드가 가상 쓰레드를 pin시킨다
public synchronized boolean joinRoom(String roomId, String userId) {
    ChatRoom room = rooms.get(roomId);
    if (room == null) return false;
    return room.addParticipant(userId);
}
```

`joinRoom()`은 단순해 보이지만 내부에 **check-then-act** 패턴이 있다.

```java
// ChatRoom.addParticipant() 내부
public boolean addParticipant(String userId) {
    if (isFull()) return false;   // ① 확인
    participants.add(userId);     // ② 행동
    return true;
}
```

①과 ② 사이의 원자성을 보장하기 위해 `synchronized`를 사용했다. 이 선택 자체는 정확하지만, 가상 쓰레드 환경에서 intrinsic lock을 사용했기 때문에 pinning이 유발된다.

---

## 5. 해결책 1 — ReentrantLock 도입

### 왜 ReentrantLock인가

`java.util.concurrent.locks.ReentrantLock`은 `synchronized`와 동일한 상호 배제(mutual exclusion)를 제공하지만, **JVM이 가상 쓰레드를 park 상태로 unmount할 수 있도록 허용**한다.

| 항목 | `synchronized` | `ReentrantLock` |
|------|---------------|-----------------|
| 락 구현 | Intrinsic lock (객체 헤더 + OS mutex) | `AbstractQueuedSynchronizer` (AQS, 순수 Java) |
| 가상 쓰레드 unmount | 불가능 (carrier에 pin됨) | 가능 (힙 기반 park로 unmount됨) |
| 락 대기 중 상태 | OS 수준 블로킹 | Java LockSupport.park() (unmount 가능) |
| 공정성 옵션 | 없음 | `new ReentrantLock(true)` 로 fair 모드 지원 |
| 조건 변수 | `wait()` / `notify()` | `Condition` 인터페이스 |

`ReentrantLock`이 락 경합 시 `LockSupport.park()`를 사용하기 때문에, JVM은 대기 중인 가상 쓰레드를 carrier thread에서 unmount하고 힙에 보존한 뒤, 락이 풀리면 다시 mount하여 실행을 재개할 수 있다.

### Pinning 해소 흐름 (ReentrantLock 적용 후)

```
가상 쓰레드 V1이 joinLock.lock() 획득 후 joinRoom() 실행
        │
가상 쓰레드 V2가 joinLock.lock() 시도 → 이미 잠김
        │
        ▼
LockSupport.park(V2) 호출
        │
        ▼
JVM: V2의 스택을 힙으로 이전 → Carrier-Thread-N에서 V2 unmount
        │
        ▼
Carrier-Thread-N은 다른 가상 쓰레드(V3, V4...) 실행 가능
        │
V1이 joinLock.unlock() 호출
        │
        ▼
LockSupport.unpark(V2) 호출 → V2를 스케줄 큐에 복귀
        │
        ▼
V2가 다시 carrier thread에 mount되어 실행 재개
```

### 수정 후 코드 (TO-BE)

```java
import java.util.concurrent.locks.ReentrantLock;

@Component
public class ChatRoomStore {

    private final ConcurrentHashMap<String, ChatRoom> rooms = new ConcurrentHashMap<>();
    private final ReentrantLock joinLock = new ReentrantLock();  // ← 추가

    /**
     * Thread-safe check-then-act: only adds the participant if the room is not full.
     * Returns true on success, false if the room is full or not found.
     */
    public boolean joinRoom(String roomId, String userId) {  // synchronized 제거
        joinLock.lock();
        try {
            ChatRoom room = rooms.get(roomId);
            if (room == null) return false;
            return room.addParticipant(userId);
        } finally {
            joinLock.unlock();  // 예외 발생 시에도 반드시 해제
        }
    }
}
```

**설계 포인트**

- `try-finally` 패턴은 필수다. `ReentrantLock`은 `synchronized`와 달리 예외가 발생해도 자동으로 락을 해제하지 않는다. `finally` 블록이 없으면 예외 발생 시 데드락이 유발된다.
- `joinLock`은 `joinRoom()`만 보호한다. `leaveRoom()`은 `ConcurrentHashMap`의 원자적 `remove()`를 사용하므로 별도 락이 불필요하다.
- `addParticipant()`의 check-then-act 원자성은 `joinLock`이 동일하게 보장한다.

---

## 6. 해결책 2 — Pinning 탐지 옵션 추가

코드 수정만으로는 부족하다. **pinning이 실제로 사라졌는지 관찰할 수단**이 필요하다.

### 6-1. `-Djdk.tracePinnedThreads` 옵션

`build.gradle`에 `bootRun` 태스크 설정을 추가했다.

```groovy
tasks.named('bootRun') {
    jvmArgs = [
        '-Djdk.tracePinnedThreads=full'
    ]
}
```

| 값 | 동작 |
|----|------|
| `full` | pinning 발생 시 전체 스택 트레이스를 표준 출력에 출력 |
| `short` | 간략한 트레이스만 출력 (로그 억제가 필요한 경우) |

**수정 전** `./gradlew bootRun` 실행 시 콘솔에 아래와 같은 스택 트레이스가 출력된다.

```
Thread[#52,ForkJoinPool-1-worker-5,5,CarrierThreads]
    com.example...ChatRoomStore.joinRoom(ChatRoomStore.java:36) <== monitors:1
    com.example...ChatService.join(ChatService.java:44)
    ...
```

`<== monitors:1` 표시가 pinning의 직접적인 증거다. `synchronized` intrinsic lock을 1개 보유한 채 블로킹 상태임을 의미한다.

**수정 후**에는 이 출력이 사라진다.

### 6-2. JFR (Java Flight Recorder) — 운영 환경 모니터링

운영 환경에서는 콘솔 출력 대신 JFR로 조용히 수집한다.

```groovy
tasks.named('bootRun') {
    jvmArgs = [
        '-Djdk.tracePinnedThreads=full',
        '-XX:StartFlightRecording=filename=recording.jfr,settings=default,duration=60s'
    ]
}
```

수집된 `.jfr` 파일은 다음 명령으로 분석한다.

```bash
# CLI로 jdk.VirtualThreadPinned 이벤트만 추출
jfr print --events jdk.VirtualThreadPinned recording.jfr
```

`jdk.VirtualThreadPinned` 이벤트가 0건이면 pinning이 완전히 해소된 것이다.

---

## 7. 적용 전후 비교

k6 부하 테스트(최대 1000 VU, 3분 10초) 기준으로 수정 후 측정한 결과다.

### 성능 지표

| 지표 | 목표 임계값 | 실측값 | 결과 |
|------|-----------|-------|------|
| msg_roundtrip P99 | < 2,000ms | **6ms** | ✅ 통과 |
| ws_connect P95 | < 3,000ms | **3ms** | ✅ 통과 |
| ws_error_rate | < 5% | **0.00%** | ✅ 통과 |
| checks_failed | 0건 | **0 / 60,966** | ✅ 통과 |

### 가상 쓰레드 효율

| 항목 | 값 |
|------|-----|
| 동시 VU | 1,000 |
| JVM live threads (테스트 종료 시점) | **99개** |
| 메시지 수신 처리량 | **3,116/s** |
| HTTP 요청 처리량 | **141/s** |

JVM 쓰레드 99개로 1,000개의 동시 WebSocket 연결을 처리했다. pinning이 해소되어 가상 쓰레드가 carrier thread를 효율적으로 공유하고 있음을 보여준다. 만약 pinning이 유지됐다면 쓰레드 수가 VU 수에 가깝게 증가했을 것이다.

### 수정 파일 요약

| 파일 | 변경 내용 |
|------|-----------|
| `src/main/java/.../store/ChatRoomStore.java` | `synchronized` 제거, `ReentrantLock` 필드 추가 및 `try-finally` 패턴 적용 |
| `build.gradle` | `bootRun` 태스크에 `-Djdk.tracePinnedThreads=full` JVM 옵션 추가 |

## 8. k6 run k6/ws-stomp-test.js 테스트 결과
~~~
sunmin@iseonmin-ui-MacBookPro websoket-vtualTread-test % k6 run k6/ws-stomp-test.js

         /\      Grafana   /‾‾/                                                                                                                                                                                                          
    /\  /  \     |\  __   /  /                                                                                                                                                                                                           
   /  \/    \    | |/ /  /   ‾‾\                                                                                                                                                                                                         
  /          \   |   (  |  (‾)  |                                                                                                                                                                                                        
 / __________ \  |_|\_\  \_____/ 


     execution: local
        script: k6/ws-stomp-test.js
        output: -

     scenarios: (100.00%) 1 scenario, 1000 max VUs, 3m40s max duration (incl. graceful stop):
              * default: Up to 1000 looping VUs for 3m10s over 7 stages (gracefulRampDown: 30s, gracefulStop: 30s)

WARN[0148] The test has generated metrics with 100091 unique time series, which is higher than the suggested limit of 100000 and could cause high memory usage. Consider not using high-cardinality values like unique IDs as metric tags or, if you need them in the URL, use the name metric tag or URL grouping. See https://grafana.com/docs/k6/latest/using-k6/tags-and-groups/ for details.  component=metrics-engine-ingester
INFO[0215] 
[Actuator] JVM live threads at end of test: 99  source=console


  █ THRESHOLDS 

    msg_roundtrip_ms
    ✓ 'p(99)<2000' p(99)=6ms

    ws_connect_duration_ms
    ✓ 'p(95)<3000' p(95)=3ms

    ws_error_rate
    ✓ 'rate<0.05' rate=0.00%


  █ TOTAL RESULTS 

    checks_total.......: 60966   283.423219/s
    checks_succeeded...: 100.00% 60966 out of 60966
    checks_failed......: 0.00%   0 out of 60966

    ✓ room created (201)
    ✓ ws status 101

    CUSTOM
    messages_received..............: 670450 3116.837203/s
    messages_sent..................: 609500 2833.488366/s
    msg_roundtrip_ms...............: avg=762.44µs min=0s       med=1ms     max=37ms    p(90)=2ms    p(95)=3ms   

    HTTP
    http_req_duration..............: avg=1.34ms   min=266µs    med=1.03ms  max=55.35ms p(90)=2.3ms  p(95)=3.2ms 
      { expected_response:true }...: avg=1.34ms   min=266µs    med=1.03ms  max=55.35ms p(90)=2.3ms  p(95)=3.2ms 
    http_req_failed................: 0.00%  0 out of 30484
    http_reqs......................: 30484  141.716258/s

    EXECUTION
    iteration_duration.............: avg=3.01s    min=3s       med=3s      max=31.01s  p(90)=3.02s  p(95)=3.02s 
    iterations.....................: 30483  141.711609/s
    vus............................: 1      min=1          max=1000
    vus_max........................: 1000   min=1000       max=1000

    NETWORK
    data_received..................: 270 MB 1.3 MB/s
    data_sent......................: 165 MB 767 kB/s

    WEBSOCKET
    ws_connect_duration_ms.........: avg=880.26µs min=0s       med=1ms     max=27ms    p(90)=2ms    p(95)=3ms   
    ws_connecting..................: avg=837.52µs min=180.83µs med=547.2µs max=26.62ms p(90)=1.58ms p(95)=2.44ms
    ws_error_rate..................: 0.00%  0 out of 60966
    ws_msgs_received...............: 731424 3400.297613/s
    ws_msgs_sent...................: 731424 3400.297613/s
    ws_session_duration............: avg=2.01s    min=2s       med=2s      max=30s     p(90)=2.01s  p(95)=2.02s 
    ws_sessions....................: 30483  141.711609/s




running (3m35.1s), 0000/1000 VUs, 30483 complete and 0 interrupted iterations
default ✓ [======================================] 0000/1000 VUs  3m10s
~~~