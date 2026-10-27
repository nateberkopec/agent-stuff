---
name: grill-me
description: A relentless interview to sharpen a plan or design.
disable-model-invocation: true
license: "MIT; copyright Matt Pocock; see ../matt-pocock-skills-LICENSE.txt"
source: https://github.com/mattpocock/skills/blob/885e2ca4d842d139e9aef4e48d366c63cb1b8013/skills/productivity/grill-me/SKILL.md
---

Read the `grilling` skill and follow its interview process.

Collect each question round with the `answer` tool. Give each question its number and title in `question`, its explanation in `context`, its options in `choices`, and the index of your recommended option in `recommended`. Use the returned answers to advance the design tree and call `answer` again for the next round. When the user cancels, stop until they ask to resume. If the tool is unavailable, present the round in chat and wait for the user's reply.
