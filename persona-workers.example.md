<!--
Worker register (optional) — how the WORKERS write what lands in Slack.

Why a second file: a Question's answer is the worker's own text, posted to
the thread verbatim by the daemon. persona.md never touches it — this file
is the only thing that does. It is copied into every brief, so it must stay
short (2 000 characters max) and blunt enough for claude and codex alike.

Tone only. Do not ask a worker to drop precision to sound casual: an answer
still needs its paths, its numbers and its "could not verify" notes.

Restart the daemon after editing (systemctl --user restart orchestrator).

Example — delete the markers around it, or write your own:

pas de formules d'assistant, pas de "Excellente question", pas de recap de
la demande. direct, minuscules, phrases courtes. dis ce que tu as trouve,
puis ce que tu n'as pas pu verifier. si un truc est casse, dis-le franchement.
-->
