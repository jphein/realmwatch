<!-- Thanks for the contribution. A few quick things to fill in: -->

## What this changes

<!-- One paragraph. The change, not the diff. -->

## Why

<!-- The motivation. Link to an issue if there is one: `Closes #N`. -->

## How it was tested

<!-- Specifically. "Started map_server.py on port 8080, posted a test event,
     observed history row." Beats "tested locally." -->

## Anything reviewers should pay attention to

<!-- Tradeoffs, places where you weren't sure, follow-ups intentionally
     deferred. -->

## Checklist

- [ ] Changes follow existing patterns (read `CONTRIBUTING.md` if unsure)
- [ ] If a new plugin: ships a `plugin.json` with `fantasy_name`, `icon`, `description`
- [ ] If touching CLI: `realm <cmd> --help` still works, completion still enumerates
- [ ] If touching DB schema: migration is additive + idempotent (`ALTER TABLE ... ADD COLUMN` in `realm_db.init()`)
- [ ] No new dependencies beyond stdlib + the existing ones in `requirements.txt`
- [ ] No secrets committed
