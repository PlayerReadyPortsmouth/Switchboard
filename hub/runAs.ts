/** Run an agent as its own OS user.
 *
 *  `runtime.envPassthrough` keeps the hub's variables out of an agent's
 *  environment, but the filesystem is still wide open: every agent runs as the
 *  hub's user, so `Read` on an absolute path reaches any file that user can
 *  reach, including another agent's env file and the hub's own `.env`.
 *
 *  Dropping to a per-agent unix user makes that boundary one the kernel enforces
 *  rather than one the prompt requests. `Bun.spawn` takes no uid or gid, so this
 *  wraps the exec vector in `setpriv` (util-linux, present on every Ubuntu box we
 *  run), which drops privilege and then execs the real binary in place.
 *
 *  Opt-in: with no `runAs` the exec vector is returned untouched.
 */

export interface RunAsSpec {
  /** Unix user name or numeric uid to drop to. */
  user: string
  /** Optional group name or gid. Defaults to the user's own primary group. */
  group?: string
  /** Supplementary groups from /etc/group. Default true, so the agent gets the
   *  groups it was actually granted rather than an empty set. */
  initGroups?: boolean
}

/** Anything that is not a plain user/group token would end up as a shell-free
 *  argv element, so injection is not the risk — a typo silently running as the
 *  wrong account is. Keep it to what a real account name can be. */
const NAME = /^[A-Za-z0-9._-]{1,64}$/

export function validateRunAs(spec: RunAsSpec, agentName: string): void {
  if (!NAME.test(spec.user)) {
    throw new Error(`config: agent "${agentName}" has invalid runtime.runAs.user "${spec.user}"`)
  }
  if (spec.group !== undefined && !NAME.test(spec.group)) {
    throw new Error(`config: agent "${agentName}" has invalid runtime.runAs.group "${spec.group}"`)
  }
}

/** Build the exec vector for one agent.
 *
 *  @param bin       the provider binary ("claude" / "codex")
 *  @param argv      its arguments
 *  @param runAs     the agent's runAs config, if any
 *  @param opts.uid  the hub's own uid (default `process.getuid?.()`), used to refuse
 *                   a configuration that cannot work
 *  @param opts.setprivPath  override for tests
 */
export function buildExecVector(
  bin: string,
  argv: string[],
  runAs?: RunAsSpec,
  opts: { uid?: number | undefined; setprivPath?: string } = {},
): { bin: string; argv: string[] } {
  if (!runAs) return { bin, argv }

  const uid = opts.uid !== undefined ? opts.uid : process.getuid?.()
  // Dropping privilege is only possible downwards. Failing loudly beats running
  // the agent as the hub user while the config claims otherwise, which would be
  // an isolation boundary that exists only on paper.
  if (uid !== 0) {
    throw new Error(
      `runAs is configured for this agent but the hub is not running as root (uid ${uid}), so it cannot drop privileges. `
      + `Either run the hub as root or remove runAs.`,
    )
  }

  const setpriv = opts.setprivPath ?? "setpriv"
  const flags = [`--reuid=${runAs.user}`, `--regid=${runAs.group ?? runAs.user}`]
  if (runAs.initGroups !== false) flags.push("--init-groups")
  // `--` stops setpriv parsing what follows, so the agent's own flags are never
  // mistaken for setpriv's.
  return { bin: setpriv, argv: [...flags, "--", bin, ...argv] }
}
