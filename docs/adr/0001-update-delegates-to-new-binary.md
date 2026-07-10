# After the install step, `orc update` delegates everything to the new binary

The `orc update` process is, by definition, the *old* version of the code
while it runs. Once `npm install -g` has swapped the package, any remaining
ritual step executed in-process (e.g. calling the already-imported
`runServiceInstall()`) would generate version N's systemd unit for version
N+1's daemon — a version-skew bug that stays dormant until the first release
that changes the unit template, and then bites exactly the users who updated
the recommended way. So after the install step the old process may only
orchestrate: it spawns the freshly installed `orc` (e.g. `orc service
install`) as a child process for every remaining action, at the cost of one
subprocess spawn.
