const core = require('@actions/core');
const github = require('@actions/github');
const utils = require('./utils.js');

const usage = 'Grade types must start with "f" for functionality (test) grades or "d" for design (code review) grades.';

function checkRequestType() {
  const type = core.getInput('type');
  core.info(`\nChecking "${type}" request type...`);

  if (!type) {
    throw new Error(`Missing required project grade type. ${usage}`);
  }

  switch (type.charAt(0)) {
    case 'd': case 'D':
      return 'Design';
    case 'f': case 'F':
      return 'Functionality';
    default:
      throw new Error(`The value "${type}" is not a valid project grade type. ${usage}`);
  }
}

async function checkRelease(octokit) {
  const release = core.getInput('release');

  const owner = github.context.repo.owner;
  const repo = github.context.repo.repo;

  core.info(`\nChecking release ${release} from ${repo}...`);

  let result;

  try {
    result = await octokit.repos.getReleaseByTag({
      owner: owner, repo: repo, tag: release
    });
  }
  catch (error) {
    // better error output than provided
    throw new Error(`Unable to find release ${result} (${error.message.toLowerCase()}).`);
  }

  if (result.status != 200) {
    core.info(`Result: ${JSON.stringify(result)}`);
    throw new Error(`The value "${release}" is not a valid project release.`);
  }

  return result;
}

async function checkFunctionality(octokit, release) {
  core.info('\nGetting workflow runs...');
  const runs = await octokit.actions.listWorkflowRuns({
    owner: github.context.repo.owner,
    repo: github.context.repo.repo,
    workflow_id: 'run-tests.yml',
    event: 'release'
  });

  if (runs.status != 200) {
    core.info(`Result: ${JSON.stringify(runs)}`);
    throw new Error(`Unable to list workflows for ${github.context.repo.repo}.`);
  }

  // It is possible the run is on a separate page, but why would you request
  // this check if there have been that many other runs?

  const branches = runs.data.workflow_runs.map(r => r.head_branch);
  core.info(`Fetched ${runs.data.workflow_runs.length} workflow runs: ${branches.join(', ')}`);

  const found = runs.data.workflow_runs.find(r => r.head_branch === release);

  if (found === undefined) {
    throw new Error(`Could not find any recent runs for the ${release} release.`);
    // core.warning(`Could not find any recent runs for the ${release} release. This could be due to ongoing issues with Github Actions. Please manually verify.`);
    // return {
    //   name: 'UNCONFIRMED',
    //   run_number: 'UNCONFIRMED',
    //   id: 'UNCONFIRMED',
    //   html_url: `https://github.com/${github.context.repo.owner}/${github.context.repo.repo}/actions`
    // };
  }

  if (found.status != "completed" || found.conclusion != "success") {
    core.info(`Result: ${JSON.stringify(found)}`);
    throw new Error(`The workflow run #${found.run_number} (${found.id}) for the ${release} release was not successful.`);
  }

  return found;
}

async function run() {
  try {
    const token = core.getInput('token');
    core.setSecret(token);

    const octokit = github.getOctokit(token);
    const states = {};

    // -----------------------------------------------
    core.startGroup('Verifying request input...');

    states.type = checkRequestType();
    core.info(`Requesting project ${states.type.toLowerCase()} grade.`);

    const release = await checkRelease(octokit);
    states.release = release.data.tag_name;
    states.releaseId = release.data.id;
    states.releaseUrl = release.data.html_url;
    states.releaseDate = release.data.created_at;
    core.info(`Found release at: ${states.releaseUrl}\n`);

    core.endGroup();

    // -----------------------------------------------
    core.startGroup(`Verifying release ${states.release} passed...`);

    const run = await checkFunctionality(octokit, states.release);
    states.runNumber = run.run_number;
    states.runId = run.id;
    states.runUrl = run.html_url;
    core.info(`Found successful "${run.name}" run #${states.runNumber} (ID: ${states.runId}) for the ${states.release} release.\n`);

    core.endGroup();

    // save results for main phase
    utils.saveStates(states);
  }
  catch (error) {
    // show error in group
    utils.showError(`${error.message}\n`);
    core.endGroup();

    // displays outside of group; always visible
    core.setFailed(`Invalid project grade request. ${error.message}`);
  }
}

run();
