import { createRequire } from "node:module";
import { assign, pick } from "lodash-es";
import * as marked from "marked";
import envCi from "env-ci";
import { hookStd } from "hook-std";
import semver from "semver";
import AggregateError from "aggregate-error";
import hideSensitive from "./lib/hide-sensitive.js";
import getConfig from "./lib/get-config.js";
import verify from "./lib/verify.js";
import getNextVersion from "./lib/get-next-version.js";
import getCommits from "./lib/get-commits.js";
import getLastRelease from "./lib/get-last-release.js";
import getReleaseToAdd from "./lib/get-release-to-add.js";
import { extractErrors, makeTag } from "./lib/utils.js";
import getGitAuthUrl from "./lib/get-git-auth-url.js";
import getBranches from "./lib/branches/index.js";
import getLogger from "./lib/get-logger.js";
import { addNote, getGitHead, getTagHead, isBranchUpToDate, push, pushNotes, tag, verifyAuth } from "./lib/git.js";
import getError from "./lib/get-error.js";
import { COMMIT_EMAIL, COMMIT_NAME } from "./lib/definitions/constants.js";
import * as fs from "node:fs/promises";

const require = createRequire(import.meta.url);
const pkg = require("./package.json");

let markedOptionsSet = false;
async function terminalOutput(text) {
  if (!markedOptionsSet) {
    const { default: TerminalRenderer } = await import("marked-terminal"); // eslint-disable-line node/no-unsupported-features/es-syntax
    marked.setOptions({ renderer: new TerminalRenderer() });
    markedOptionsSet = true;
  }

  return marked.parse(text);
}

/** This function runs before each stage and does basic config & CI verification that we can repeat */
async function beforeEachStage(context) {
  const { env, options, logger } = context;
  const { isCi, isPr, branch, prBranch } = context.envCi;
  const ciBranch = isPr ? prBranch : branch;

  if (!isCi && !options.dryRun && !options.noCi) {
    logger.warn("This run was not triggered in a known CI environment, running in dry-run mode.");
    options.dryRun = true;
  } else {
    // When running on CI, set the commits author and committer info and prevent the `git` CLI to prompt for username/password. See #703.
    Object.assign(env, {
      GIT_AUTHOR_NAME: COMMIT_NAME,
      GIT_AUTHOR_EMAIL: COMMIT_EMAIL,
      GIT_COMMITTER_NAME: COMMIT_NAME,
      GIT_COMMITTER_EMAIL: COMMIT_EMAIL,
      ...env,
      GIT_ASKPASS: "echo",
      GIT_TERMINAL_PROMPT: 0,
    });
  }

  if (isCi && isPr && !options.noCi) {
    logger.log("This run was triggered by a pull request and therefore a new version won't be published.");
    return false;
  }

  // Verify config
  await verify(context);

  options.repositoryUrl = await getGitAuthUrl({ ...context, branch: { name: ciBranch } });
  context.branches = await getBranches(options.repositoryUrl, ciBranch, context);
  context.branch = context.branches.find(({ name }) => name === ciBranch);
  return true;
}

async function runPrepare(context, plugins) {
  const { cwd, env, options, logger, envCi } = context;
  const { branch, prBranch, isPr } = envCi;
  const ciBranch = isPr ? prBranch : branch;

  if (!context.branch) {
    logger.log(
      `This test run was triggered on the branch ${ciBranch}, while semantic-release is configured to only publish from ${context.branches
        .map(({ name }) => name)
        .join(", ")}, therefore a new version won’t be published.`
    );
    return false;
  }

  logger[options.dryRun ? "warn" : "success"](
    `Run automated release from branch ${ciBranch} on repository ${options.originalRepositoryURL}${
      options.dryRun ? " in dry-run mode" : ""
    }`
  );

  try {
    try {
      await verifyAuth(options.repositoryUrl, context.branch.name, { cwd, env });
    } catch (error) {
      if (!(await isBranchUpToDate(options.repositoryUrl, context.branch.name, { cwd, env }))) {
        logger.log(
          `The local branch ${context.branch.name} is behind the remote one, therefore a new version won't be published.`
        );
        return false;
      }

      throw error;
    }
  } catch (error) {
    logger.error(`The command "${error.command}" failed with the error message ${error.stderr}.`);
    throw getError("EGITNOPERMISSION", context);
  }

  logger.success(`Allowed to push to the Git repository`);

  await plugins.verifyConditions(context);

  const errors = [];
  context.releasesPublished = null;
  context.releasesAdded = null;
  const releaseToAdd = getReleaseToAdd(context);

  if (releaseToAdd) {
    const { lastRelease, currentRelease, nextRelease } = releaseToAdd;

    nextRelease.gitHead = await getTagHead(nextRelease.gitHead, { cwd, env });
    currentRelease.gitHead = await getTagHead(currentRelease.gitHead, { cwd, env });
    if (context.branch.mergeRange && !semver.satisfies(nextRelease.version, context.branch.mergeRange)) {
      errors.push(getError("EINVALIDMAINTENANCEMERGE", { ...context, nextRelease }));
    } else {
      const commits = await getCommits({ ...context, lastRelease, nextRelease });
      nextRelease.notes = await plugins.generateNotes({ ...context, commits, lastRelease, nextRelease });

      if (options.dryRun) {
        logger.warn(`Skip ${nextRelease.gitTag} tag creation in dry-run mode`);
      } else {
        await addNote({ channels: [...currentRelease.channels, nextRelease.channel] }, nextRelease.gitTag, {
          cwd,
          env,
        });
        await push(options.repositoryUrl, { cwd, env });
        await pushNotes(options.repositoryUrl, nextRelease.gitTag, {
          cwd,
          env,
        });
        logger.success(
          `Add ${nextRelease.channel ? `channel ${nextRelease.channel}` : "default channel"} to tag ${
            nextRelease.gitTag
          }`
        );
      }

      context.branch.tags.push({
        version: nextRelease.version,
        channel: nextRelease.channel,
        gitTag: nextRelease.gitTag,
        gitHead: nextRelease.gitHead,
      });

      const releases = await plugins.addChannel({ ...context, commits, lastRelease, currentRelease, nextRelease });
      context.releasesAdded = releases;
      await plugins.success({ ...context, lastRelease, commits, nextRelease, releases });
    }
  }

  if (errors.length > 0) {
    throw new AggregateError(errors);
  }

  context.lastRelease = getLastRelease(context);
  if (context.lastRelease.gitHead) {
    context.lastRelease.gitHead = await getTagHead(context.lastRelease.gitHead, { cwd, env });
  }

  if (context.lastRelease.gitTag) {
    logger.log(
      `Found git tag ${context.lastRelease.gitTag} associated with version ${context.lastRelease.version} on branch ${context.branch.name}`
    );
  } else {
    logger.log(`No git tag version found on branch ${context.branch.name}`);
  }

  context.commits = await getCommits(context);

  const nextRelease = {
    type: await plugins.analyzeCommits(context),
    channel: context.branch.channel || null,
    gitHead: await getGitHead({ cwd, env }),
  };
  if (!nextRelease.type) {
    logger.log("There are no relevant changes, so no new version is released.");
    return false;
  }

  context.nextRelease = nextRelease;
  nextRelease.version = getNextVersion(context);
  nextRelease.gitTag = makeTag(options.tagFormat, nextRelease.version);
  nextRelease.name = nextRelease.gitTag;

  if (context.branch.type !== "prerelease" && !semver.satisfies(nextRelease.version, context.branch.range)) {
    throw getError("EINVALIDNEXTVERSION", {
      ...context,
      validBranches: context.branches.filter(
        ({ type, accept }) => type !== "prerelease" && accept.includes(nextRelease.type)
      ),
    });
  }

  await plugins.verifyRelease(context);

  nextRelease.notes = await plugins.generateNotes(context);

  await plugins.prepare(context);
  return true;
}

async function runPublish(context, plugins) {
  const { cwd, env, options, logger, nextRelease } = context;

  if (options.dryRun) {
    logger.warn(`Skip ${nextRelease.gitTag} tag creation in dry-run mode`);
  } else {
    // Create the tag before calling the publish plugins as some require the tag to exists
    await tag(nextRelease.gitTag, nextRelease.gitHead, { cwd, env });
    await addNote({ channels: [nextRelease.channel] }, nextRelease.gitTag, { cwd, env });
    await push(options.repositoryUrl, { cwd, env });
    await pushNotes(options.repositoryUrl, nextRelease.gitTag, { cwd, env });
    logger.success(`Created tag ${nextRelease.gitTag}`);
  }

  const releases = await plugins.publish(context);
  context.releasesPublished = releases;
}

/* eslint complexity: off */
async function runNotify(context, plugins) {
  const { options, logger, nextRelease } = context;
  await plugins.success({ ...context, releases: context.releasesPublished });

  logger.success(
    `Published release ${nextRelease.version} on ${nextRelease.channel ? nextRelease.channel : "default"} channel`
  );

  if (options.dryRun) {
    logger.log(`Release note for version ${nextRelease.version}:`);
    if (nextRelease.notes) {
      context.stdout.write(await terminalOutput(nextRelease.notes));
    }
  }
}

const savedContextProperties = ["lastRelease", "nextRelease", "commits", "releasesPublished", "releasesAdded"];

async function loadState(stages) {
  try {
    const data = await fs.readFile(".semrel/state.json", { encoding: "utf-8" });
    return JSON.parse(data);
  } catch (err) {
    if (err.code == "ENOENT") {
      throw getError("ENOSTATE", stages);
    }
    throw err;
  }
}

async function saveState(context, processingState) {
  const state = {
    ...processingState,
    ...pick(context, savedContextProperties),
  };
  await fs.mkdir(".semrel", { recursive: true });
  await fs.writeFile(".semrel/state.json", JSON.stringify(state, null, 2), { encoding: "utf-8" });
}

function initialState() {
  return {
    stage: null,
  };
}

function getRequiredStage(stage) {
  switch (stage) {
    case "prepare":
      return null;
    case "publish":
      return "prepare";
    case "notify":
      return "publish";
    default:
      throw getError("ESTAGECONFIG", { stage });
  }
}

function contextToResult(context) {
  const releases = (context.releasesAdded || []).concat(context.releasesPublished || []);
  if (releases.length == 0) {
    return false;
  } else {
    return {
      ...pick(context, ["lastRelease", "commits", "nextRelease"]),
      releases,
    };
  }
}

async function runAll(context, plugins) {
  // run all stages as one
  // false = no release needed
  if (!(await beforeEachStage(context))) {
    return false;
  }
  if (!(await runPrepare(context, plugins))) {
    // there might be addChannel release
    return contextToResult(context);
  }
  await runPublish(context, plugins);
  await runNotify(context, plugins);

  return contextToResult(context);
}

async function runSingle(context, plugins) {
  let { logger } = context;

  // load state
  const stage = context.options.stage;
  const stages = {
    stage,
    requiredStage: getRequiredStage(stage),
  };
  let state;
  if (stages.requiredStage === null) {
    state = initialState();
  } else {
    state = await loadState(stages);
  }

  assign(context, pick(state, savedContextProperties));
  stages.previousStage = state.stage;

  // validate previous stage
  let { willPublish, failed } = { state };
  if (failed) {
    await saveState(context, { willPublish, stage, failed });
    throw getError("EPREVIOUSFAIL", stages);
  }

  if (stages.previousStage !== stages.requiredStage) {
    throw getError("EBADSTATE", stages);
  }

  // erarly bail out if nothing to do
  if (stage != "prepare" && !willPublish) {
    logger.info(`Skipping ${stage} because there is no release (see prepare stage details)`);
    return false;
  }

  // run the stage
  willPublish = await beforeEachStage(context);
  if (willPublish) {
    try {
      switch (stage) {
        case "prepare":
          willPublish = (await runPrepare(context, plugins)) && willPublish;
          break;
        case "publish":
          await runPublish(context, plugins);
          break;
        case "notify":
          await runNotify(context, plugins);
          break;
      }

      // save state
      await saveState(context, { willPublish, stage, failed: false });
    } catch (exc) {
      await saveState(context, { willPublish, stage, failed: true });
      throw exc;
    }
  }

  return contextToResult(context);
}

async function logErrors({ logger, stderr }, err) {
  const errors = extractErrors(err).sort((error) => (error.semanticRelease ? -1 : 0));
  for (const error of errors) {
    if (error.semanticRelease) {
      logger.error(`${error.code} ${error.message}`);
      if (error.details) {
        stderr.write(await terminalOutput(error.details)); // eslint-disable-line no-await-in-loop
      }
    } else {
      logger.error("An error occurred while running semantic-release: %O", error);
    }
  }
}

async function callFail(context, plugins, err) {
  const errors = extractErrors(err).filter((err) => err.semanticRelease);
  if (errors.length > 0) {
    try {
      await plugins.fail({ ...context, errors });
    } catch (error) {
      await logErrors(context, error);
    }
  }
}

export default async (cliOptions = {}, { cwd = process.cwd(), env = process.env, stdout, stderr } = {}) => {
  const { unhook } = hookStd(
    { silent: false, streams: [process.stdout, process.stderr, stdout, stderr].filter(Boolean) },
    hideSensitive(env)
  );
  const context = {
    cwd,
    env,
    stdout: stdout || process.stdout,
    stderr: stderr || process.stderr,
    envCi: envCi({ env, cwd }),
  };
  context.logger = getLogger(context);
  context.logger.log(`Running ${pkg.name} version ${pkg.version}`);
  try {
    const { plugins, options } = await getConfig(context, cliOptions);
    options.originalRepositoryURL = options.repositoryUrl;
    context.options = options;
    try {
      const result =
        context.options.stage === undefined ? await runAll(context, plugins) : await runSingle(context, plugins);
      unhook();
      return result;
    } catch (error) {
      await callFail(context, plugins, error);
      throw error;
    }
  } catch (error) {
    await logErrors(context, error);
    unhook();
    throw error;
  }
};
