# Using Individual Stages in CI

The original design of semantic-release used steps such as "verify" and "publish" internally,
but it had to be used as all-in-one tool. The idea was to run semantic release and it will do preparation,
build, publishing and everything.

The goal of this project is to decouple semantic-release from the build steps. It splits the tool in stages,
which you can interleave with your build pipeline. It is still compatible with semantic-release plugins.

## Problems

The original monolithic design does not allow you to reuse your existing CI pipelines. Existing CI Pipelines (Github, Gitlab)
are much more mature than any build steps that you could do inside semantic-release exec. You also
might want to run the build in a specific container, e.g. to ensure builds on old system, which
cannot run semantic-release.

## Design

Semantic release is now split in three stages, which you can interleave with your CI pipeline like so:

- semantic-release prepare
- CI build
- semantic-release publish
- CI publish (optional)
- sematnic-release notify (optional)

The **prepare** stage is responsible for figuring out which version of SW to build and patching
the build files like `package.json` with the correct version. After this phase, you can run your CI
pipeline to do the actual release.

The **publish** stage runs if there is a release to be done, otherwise it is a no-op. It first tags your
GIT repo and then publishes the build artifacts to repositories. After this phase, you can do additional
publish steps, if the available plugins do not suite you or the publish is hard to do withing semrel.

The **notify** stage is used to call success notification plugins. This is optional if you do not use
notifications.

We advise not to use failure notification plugins and rely on you CI infrastructure reporting of failures.
The failure notification plugins will be called, but only for failures within semantic-release.

## Communication

The stages must communicate. First, with each other, to avoid repeated work (downloading commits twice etc.).
Second, with the CI jobs written by you -- to tell it which version to use during build, if it should publish etc.

This is done using JSON files. Each stage produces a JSON file with the results of the stage, e.g. `0_publish.json`.
For convenient use from shell scripts, a sourceable files like `0_publish.sh` are also produced.

_Note:_ Unfortunately, we must produce separate files, because some CI solutions effectively do not allow overwriting files
(see https://gitlab.com/gitlab-org/gitlab/-/issues/324412).

This state meta-data is stored in the `.semrel` directory.

## Mapping to Steps

This is how the semantic release three executable stages map to steps defined by plugins.

| Stage     | Step                                                                                                      |
| --------- | --------------------------------------------------------------------------------------------------------- |
| `prepare` | `verifyConditions`, `addChannel`, `success`, `analyzeCommits`, `verifyRelease` `generateNotes`, `prepare` |
| `publish` | `gitTag`, `publish`                                                                                       |
| `notify`  | `success`                                                                                                 |

It is worth to mention that the `addChannel` step is in `preparePhase`. So do not rely on `prepare` not
having side effects if you use this feature. This step is run if
GIT tags are merged into a branch. Since the steps only adds tags existing artifacts, it does not depend
on a build being done.

## Shell Variables

`semrel/state.sh` contains variables that can be source by your shell scripts. These variables are available:

- `SR_STAGE`: last stage that was executed (sucesfully or not), e.g. `prepare`, `publish`, `notify`.
- `SR_WILL_PUBLISH`: is semantic release in release mode (did it or will it publish a release, unless failure occurs)?
- `SR_PUBLISH`: alias to `SR_WILL_PUBLISH`
- `SR_FAILED`: did any of the previous stages fail?
- `SR_NEXT_VERSION`: version of release to be published (valid only if `SR_WILL_PUBLISH`)
- `SR_NEXT_GIT_TAG`: GIT tag of the next release
- `SR_NEXT_TYPE`: type of next release, e.g. `patch`
- `SR_NEXT_CHANNEL`: release channel

If there was a previous release, there will be also `SR_PREVIOUS_*` shell variables available.

Most of the scripts should:

- not access any semantic-release variables in their build phase and build anyway
  - but may check `SR_WILL_PUBLISH` to e.g. omit some release preparation if it is appropriate
- check `SR_PUBLISH` in their publish phase and feed `SR_NEXT_VERSION` to the publish tools
