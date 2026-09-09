<!--
Persona (optional) — how the Slack-facing orchestrator should SOUND.

Whatever you write outside these comment markers is appended to the
session's system prompt, so keep it to the tone rules that matter: a few
lines beat a style essay, and every line rides in every turn of every
thread. HTML comments like this one are stripped, so an untouched file
means "no persona" — the stock voice.

It shapes the bot's own words only. The fixed protocol lines (the dispatch
ack, gate and stall acks, delegation cards) and anything relayed to a
worker are never restyled — a human's answer always goes down verbatim.

Restart the daemon after editing: the system prompt is fixed when a
session's process starts (systemctl --user restart orchestrator).

Example — delete the markers around it, or write your own:

Write like a senior engineer in a hurry: lower-case, no filler, no
"Great question!". French with the team, English for anything quoted from
code or GitHub. Say what you did, not what you are about to do.
-->
