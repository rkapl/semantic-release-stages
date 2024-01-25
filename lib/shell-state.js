import shellEscape from "shell-escape";

function encodeShellVars(obj, prefix) {
  const lines = [];
  for (const k of Object.keys(obj)) {
    const v = obj[k];
    if (v === undefined || v === null) continue;
    let str;
    if (typeof v == "string") {
      str = shellEscape([v]);
      lines.push(`${prefix}${k}=${str}`);
    } else if (typeof v == "boolean") {
      str = v ? "1" : "0";
      lines.push(`${prefix}${k}=${str}`);
    } else {
      lines.push(...encodeShellVars(v, prefix + k + "_"));
    }
  }
  return lines;
}

function encodeReleaseForShell(rel) {
  if (rel === undefined) {
    return undefined;
  }
  return {
    VERSION: rel.version,
    GIT_TAG: rel.gitTag,
    NAME: rel.name,
    TYPE: rel.type,
    CHANNEL: rel.channel,
  };
}

export function stateToShellInclude(state) {
  const shell_state = {
    STAGE: state.stage,
    WILL_PUBLISH: !!state.willPublish,
    PUBLISH: state.willPublish && !state.failed && state.stage == "publish",
    FAILED: !!state.failed,
    NEXT: encodeReleaseForShell(state.nextRelease),
    PREVIOUS: encodeReleaseForShell(state.lastRelease),
  };
  return encodeShellVars(shell_state, "SR_").join("\n");
}
