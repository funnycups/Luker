# How to contribute to Luker

Thanks for your interest in improving Luker! This file covers the essentials. For the full workflow, code style and project layout, see the [Contributing Guide](https://luker.cups.moe/development/contributing) on the docs site.

## Setting up the dev environment

1. Required software: git and [Node.js](https://nodejs.org/) 24 or newer.
2. Recommended editor: Visual Studio Code.
3. Fork this repository, clone your fork, then run `npm install` and `node server.js`.

## Getting the code ready

1. Register a GitHub account.
2. Fork this repository under your account.
3. Clone the fork onto your machine.
4. Open the cloned repository in your code editor.
5. Create a git branch off `release` (recommended), review the [git book](https://git-scm.com/book/en/v2/Getting-Started-About-Version-Control) if you haven't. Prefix the branch by intent: `feat/`, `fix/`, `docs/`, `refactor/`, `chore/`.
6. Make your changes and test them locally.
7. Commit the changes and push the branch to your fork.
8. Go to GitHub and open a pull request **against `release`**.

## Contribution guidelines

### Use the correct target branch

`release` is Luker's only long-lived branch. Everything — features, fixes, documentation — lands there through a pull request. Pick the branch name by intent, and keep the pull request pointed at `release`.

Project maintainers will test and can change your code before merging. To keep the workflow smooth, please ensure the following:

- The "Allow edits from maintainers" option is checked.
- Avoid force-pushing your branch once the PR is out of draft state.

### Maintain code quality

Use common sense and follow the existing naming conventions and formatting: 4-space indentation, single quotes, semicolons, LF line endings, and ESM syntax on both the frontend and the server. The [Contributing Guide](https://luker.cups.moe/development/contributing) has the full style reference. Note that `npm run lint` reports a large number of legacy errors in the existing codebase, so don't expect a clean run or try to fix unrelated files.

### Make contributions small and testable

To make sure that your contribution remains testable and reviewable, try not to exceed a soft limit of **200 lines of code** (both additions and deletions) per pull request. If you have more to contribute, split it into multiple pull requests.

We can also consider creating a separate feature branch for more substantial changes, but please discuss it with the maintainers first. For example:

- Leave the main larger PR as a draft so it can be used to discuss the implementation.
- Split each group of functions or features into a ~200 line PR so it can be properly reviewed and merged to `release` or a feature branch.
- If there are large codependent changes that cannot be split, start with the most utilized dependencies and stub dependent functions.
- Each will be reviewed and tested one by one, merging into the feature branch as they're ready.
- Do not create all branches in advance, as subsequent changes made in previous commits as a result of test/review may create a lot of merge conflicts.

### Provide clear descriptions of your changes

Write at least somewhat meaningful PR descriptions and commit messages. There's no "right" way to do it, but the following may help with outlining a general structure:

- What is the reason for a change?
- What did you do to achieve this?
- How would a reviewer test the change?

### Run the tests

- Unit tests: `npm run test:unit --prefix tests`
- End-to-end tests: `npm run test:e2e --prefix tests` — these drive a real server and a real browser through Playwright, so run `npx playwright install chromium` once beforehand.

Continuous integration runs the unit tests on every pull request.

### We (likely) don't speak your language

English is the primary language of communication in this project. Please use only English when writing commit messages, PR descriptions, comments and other text. This does not apply to contributions to localization files.

### Legal stuff

Mind the license. Your contributions will be licensed under the GNU Affero General Public License. If you don't know what that implies, consult your lawyer.

## Use of AI coding assistance tools ("Vibe Coding")

We do not prohibit nor encourage the use of AI tools for coding assistance to help you write code, documentation, etc. This includes specialized IDEs, plugins and add-ons, chat interfaces, etc. However, please keep in mind the following:

- No matter who (or what) wrote the code, you are responsible for it. Make sure to carefully review and test everything before committing, and be ready to discuss and fix any issues that may arise during the review.
- Maintainers can reject reviewing and accepting PRs of very low quality, i.e. if the time to fix the issues exceeds the time to write the code from scratch.
- Avoid common mistakes attributed to AI tools, such as: adding/removing unrelated comments, excessive logging, unawareness of the project context and conventions, etc.
- You are allowed, but not required, to trigger AI tools that are added to the project by maintainers (Gemini, Copilot, Codex). Keep in mind that any feedback (comments, suggestions) that these tools generate is not a call to action; make sure to properly assess it before applying.

## Further reading

1. [Contributing Guide](https://luker.cups.moe/development/contributing) — full workflow, code style and project structure
2. [How to write frontend plugins](https://luker.cups.moe/development/frontend-plugin)
3. [How to write server plugins](https://luker.cups.moe/development/server-plugin)
4. [Extension API reference](https://luker.cups.moe/development/extension-api/)
5. [Card developer reference](https://luker.cups.moe/development/card-developers)

Questions? Open an issue at <https://github.com/funnycups/Luker/issues>.
