#!/bin/bash
curl -s localhost:8080/actuator/metrics/jvm.threads.live \
  | python3 -c "
import sys, json
d = json.load(sys.stdin)
v = next(m['value'] for m in d['measurements'] if m['statistic'] == 'VALUE')
print(f'JVM live threads: {int(v)}')
"
