# 추가 테스트 계획

## 2026-03-04

현재까지 Blocking I/O 환경에서의 레이턴시, 처리량, 스레드 수 절감 효과를 검증했다.
아래는 아직 검증하지 않은 영역으로, Virtual Thread 도입 효과를 더 깊이 이해하기 위해 수행할 수 있다.

---

## 1. 최대 동시 연결 한계 테스트

### 목적

현재 테스트는 REST 800 VU, WebSocket 1,000 VU까지만 진행했다.
Virtual Thread ON/OFF 각각의 **최대 동시 연결 수 한계점**을 찾지 않았다.

### 테스트 설계

```
VU를 단계적으로 증가시키며 첫 번째 에러(connection refused, timeout)가 발생하는 지점 탐색

REST:   800 → 1,500 → 2,000 → 3,000 → 5,000
WebSocket: 1,000 → 2,000 → 3,000 → 5,000

각 단계에서 기록할 지표:
  - 첫 에러 발생 VU 수
  - 에러율이 1%를 넘는 VU 수
  - 서버 프로세스 상태 (OOM, crash 여부)
```

### 기대 결과

- Platform Thread: Tomcat 스레드 풀(200) + 큐(기본 100) 한계에서 connection refused 발생 예상
- Virtual Thread: JVM 힙 메모리가 허용하는 범위까지 연결 수용 가능 → 한계점이 수천~수만 VU로 상승 예상

### 주의 사항

- 로컬 macOS의 파일 디스크립터 제한(`ulimit -n`)을 충분히 올려야 함 (기본 256 → 최소 10,000)
- k6 자체도 VU당 소켓을 사용하므로 k6 측 리소스 한계도 확인 필요

---

## 2. 메모리 사용량 비교

### 목적

스레드 수 차이(217 vs 32)를 확인했지만, **실제 힙/RSS 메모리 사용량 차이**는 측정하지 않았다.
Virtual Thread의 또 다른 핵심 이점인 메모리 절감 효과를 수치화한다.

### 테스트 설계

```
테스트 중 주기적으로(5초 간격) 다음 메트릭 수집:

1. JVM 힙 메모리
   - GET /actuator/metrics/jvm.memory.used?tag=area:heap

2. JVM 논힙 메모리
   - GET /actuator/metrics/jvm.memory.used?tag=area:nonheap

3. OS 프로세스 RSS (Resident Set Size)
   - ps -o rss -p <PID>

4. GC 횟수 및 일시정지 시간
   - GET /actuator/metrics/jvm.gc.pause
```

k6 스크립트에 주기적 수집 로직을 추가하거나, 별도 모니터링 스크립트를 병렬 실행한다.

### 기대 결과

| 지표 | Platform Thread | Virtual Thread | 예상 차이 |
|------|----------------|----------------|----------|
| OS 스레드 스택 | 217 × 1MB = 217MB | 32 × 1MB = 32MB | ▼ 85% |
| VT 스택 | 해당 없음 | 수천 개 × 수 KB | 수 MB 수준 |
| 힙 사용량 | 높음 (큐 적체, 대기 객체) | 낮음 | 검증 필요 |
| GC 압박 | 높음 | 낮음 | 검증 필요 |

---

## 3. 장시간 부하 안정성 테스트 (Soak Test)

### 목적

현재 테스트는 REST 1분 40초, WebSocket 3분 10초로 짧다.
실제 채팅 서비스는 연결을 **수십 분~수 시간 유지**한다.
장시간 부하에서 **메모리 누수, GC 압박, 성능 저하** 여부를 확인한다.

### 테스트 설계

```
WebSocket Soak Test:
  - 고정 VU: 500
  - 지속 시간: 30분 ~ 1시간
  - VU당 메시지 전송: 무제한 (100ms 간격 연속)

모니터링 지표:
  - msg_roundtrip_ms의 시간에 따른 추이 (증가하면 성능 저하)
  - JVM 힙 메모리 추이 (단조 증가하면 메모리 누수)
  - GC pause 빈도 및 시간
  - 에러율 추이
```

### 기대 확인 항목

- Virtual Thread 스택이 GC에 의해 정상 회수되는지
- carrier thread 풀이 장시간 운영에서도 안정적인지
- STOMP 세션 누적으로 인한 메모리 증가 여부

---

## 4. 혼합 워크로드 테스트 (REST + WebSocket 동시)

### 목적

실제 프로덕션에서는 REST API(방 생성/조회)와 WebSocket(채팅)이 **동시에 사용**된다.
두 프로토콜이 동시에 부하를 받을 때 서로 영향을 주는지 확인한다.

### 테스트 설계

```
동시 실행:
  - k6 인스턴스 1: k6 run k6/rest-blocking-test.js
  - k6 인스턴스 2: k6 run k6/ws-stomp-test.js

또는 단일 스크립트에 3개 시나리오:
  scenarios: {
    rest_read:  { exec: 'readScenario',  vus: 300 },
    rest_write: { exec: 'writeScenario', vus: 100 },
    ws_chat:    { exec: 'wsScenario',    vus: 500 },
  }
```

### 기대 확인 항목

- Platform Thread: Tomcat 풀을 REST와 WebSocket이 공유하므로 경합 발생 예상
- Virtual Thread: 독립적으로 처리되어 상호 영향 최소화 예상
- REST latency가 WebSocket 부하에 의해 증가하는지 여부

---

## 5. 핀닝(Pinning) 감지 테스트

### 목적

현재 코드는 `ReentrantLock`을 사용하여 핀닝이 없지만,
실제 DB(JPA/Hibernate)나 HTTP 클라이언트를 연동할 경우 서드파티 라이브러리의 `synchronized` 블록에서 핀닝이 발생할 수 있다.

### 테스트 설계

```
1. JVM 옵션 추가:
   -Djdk.tracePinnedThreads=full

2. Thread.sleep() 대신 실제 DB 호출로 교체:
   - H2 인메모리 DB + JPA
   - simulateDbRead() → roomRepository.findAll()
   - simulateDbWrite() → roomRepository.save(new Room(...))

3. 부하 테스트 실행 후 콘솔에 핀닝 로그 확인
```

### 기대 확인 항목

- JDBC 드라이버(H2, MySQL 등)에서 핀닝 발생 여부
- Hibernate 내부 `synchronized` 블록 존재 여부
- 핀닝 발생 시 성능에 미치는 실제 영향도

---

## 우선순위

| 순위 | 테스트 | 이유 |
|------|--------|------|
| 1 | 최대 동시 연결 한계 | 가장 직관적인 비교 수치, 구현 간단 |
| 2 | 메모리 사용량 비교 | 운영 비용 절감 근거, Actuator로 쉽게 수집 |
| 3 | 핀닝 감지 | 실제 DB 연동 시 반드시 확인 필요 |
| 4 | 장시간 안정성 | 프로덕션 배포 전 필수, 시간 소요 큼 |
| 5 | 혼합 워크로드 | 실제 운영 시나리오 재현, 스크립트 구현 복잡 |
