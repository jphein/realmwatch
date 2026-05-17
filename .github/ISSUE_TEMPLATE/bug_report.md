---
name: Bug report
about: Something in realmwatch isn't working the way you expected.
title: '[bug] '
labels: bug
---

## What happened

<!-- One or two sentences. What did you do, what did you expect, what did you see instead? -->

## Reproduce

<!-- A minimal set of steps. Pretend you're typing them into a fresh clone. -->

```
$ git clone https://github.com/jphein/realmwatch
$ cd realmwatch
$ ...
```

## Environment

- Realmwatch version: <!-- output of `realm --version` -->
- Python: <!-- `python3 --version` -->
- OS: <!-- `cat /etc/os-release | head -1` -->
- Plugin involved (if known): <!-- e.g. plugins/alerting -->

## Logs

<details><summary>Server log around the error</summary>

```
<!-- paste the last 30 lines from map_server.py stderr -->
```

</details>

## What might be related

<!-- Optional. Any recent commits, config changes, new hosts added, etc. -->
