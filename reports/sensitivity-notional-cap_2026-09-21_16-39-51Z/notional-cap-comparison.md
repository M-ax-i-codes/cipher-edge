# Notional-cap sensitivity (OBSERVED)

Config default `risk.maxPositionNotionalPct` = **20%** and was **not** changed.
The alternative cap **33%** was applied as a per-run override only.

| cap % | default? | trades | capped trades | binding constraint | avg intended risk % | avg actual risk % | return % | maxDD % | netPnl | max exposure % |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
20 | yes | 100 | 100 | {"notional-cap":100} | 0.5 | 0.1262 | -5.807 | 6.39 | -580.72 | 60.14
33 | no | 100 | 100 | {"notional-cap":100} | 0.5 | 0.2082 | -9.417 | 10.337 | -941.66 | 99.25

Reading this table: `avg intended risk %` is what the 0.5% risk budget asked for;
`avg actual risk %` is what was really at hazard after the cap. A cap can only reduce risk,
never increase it, and the reduction is reported here rather than absorbed silently.
