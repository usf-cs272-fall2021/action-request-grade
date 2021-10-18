const core = require('@actions/core');
const github = require('@actions/github');

var { DateTime } = require('luxon');

const constants = require('./constants.js');
const utils = require('./utils.js');

const zone = 'America/Los_Angeles';

function getProject(release) {
  const regex = /^v([1-4])\.(\d+)\.(\d+)$/;
  const matched = release.match(regex);

  if (matched !== null && matched.length === 4) {
    return parseInt(matched[1]);
  }

  throw new Error(`Unable to parse project from release ${release}.`);
}

function calculateGrade(created, project, type) {
  core.startGroup(`Calculating project ${project} ${type.toLowerCase()} grade...`);

  const results = {};
  core.info(`\nSubmitted date: ${created}`);

  // all github timestamps are in ISO 8601 format
  const createdDate = DateTime.fromISO(created).setZone(zone);
  results.created = createdDate.toLocaleString(DateTime.DATETIME_FULL);
  core.info(`Parsed submitted date: ${results.created}`);

  const deadlineText = `${constants[type.toLowerCase()][project]}T23:59:59`
  const deadline = DateTime.fromISO(deadlineText, {zone: zone});
  results.deadline = deadline.toLocaleString(DateTime.DATETIME_FULL);
  core.info(`Parsed ${type.toLowerCase()} deadline: ${results.deadline}`);

  results.penalty = constants['penalty'][type.toLowerCase()];
  results.hours = constants['hours'][type.toLowerCase()];
  results.capped = constants['capped'][type.toLowerCase()];

  if (createdDate < deadline) {
    core.info(`Submitted before deadline!`);
    results.late = 0;
  }
  else {
    const hours = createdDate.diff(deadline, 'hours').toObject().hours;
    core.info(`Submitted ${hours} hour(s) late.`);

    results.late = 1 + Math.floor(hours / results.hours);
    core.info(`Using ${results.late}x late penalty multiplier.`);
  }

  results.deduction = Math.min(results.capped, results.late * results.penalty);
  results.grade = 100 - results.deduction;

  core.info(`Project ${project} ${type.toLowerCase()} earned a ${results.grade}% grade (before deductions).`);

  core.info(JSON.stringify(results));
  core.info('');
  core.endGroup();

  return results;
}

async function findIssues(octokit, project, type) {
  core.info(`Looking up issues for project ${project}...`);

  const labels = [`project${project}`];

  if (type) {
    labels.push(type.toLowerCase());
    core.info(`Only including ${type.toLowerCase()} issues.`);
  }

  const result = await octokit.issues.listForRepo({
    owner: github.context.repo.owner,
    repo: github.context.repo.repo,
    labels: labels.join(','),
    state: 'all',
    sort: 'created',
    direction: 'asc'
  });

  if (result.status == 200) {
    core.info(`Found ${result.data.length} issues for project ${project}.`);
    return result.data;
  }

  throw new Error(`Unable to list issues for ${github.context.repo.repo}.`);
}

async function getMilestone(octokit, project) {
  const title = `Project ${project}`;

  core.info('\nListing milestones...');
  const milestones = await octokit.issues.listMilestones({
    owner: github.context.repo.owner,
    repo: github.context.repo.repo
  });

  if (milestones.status == 200) {
    const found = milestones.data.find(x => x.title === title);

    if (found === undefined) {
      const create = await octokit.issues.createMilestone({
        owner: github.context.repo.owner,
        repo: github.context.repo.repo,
        title: title,
        state: 'open',
        description: `Project ${project} ${constants.names[project]}`
      });

      if (create.status == 201) {
        core.info(`Created ${create.data.title} milestone.`);
        return create.data;
      }

      core.info(`Result: ${JSON.stringify(create)}`);
      throw new Error(`Unable to create ${title} milestone.`);
    }
    else {
      core.info(`Found ${found.title} milestone.`);
      return found;
    }
  }

  core.info(`Result: ${JSON.stringify(milestones)}`);
  throw new Error('Unable to list milestones.');
}

async function createIssue(octokit, project, type, title, body) {
  const labels = [`project${project}`, type.toLowerCase()];
  const assignees = constants.assign[type.toLowerCase()];

  const milestone = await getMilestone(octokit, project);

  core.info(`\nCreating ${type.toLowerCase()} issue...`);
  const issue = await octokit.issues.create({
    owner: github.context.repo.owner,
    repo: github.context.repo.repo,
    assignees: assignees,
    labels: labels,
    milestone: milestone.number,
    title: title,
    body: body
  });

  if (issue.status == 201) {
    core.info(`Created issue #${issue.data.number}.`);
    return issue;
  }

  core.info(`Result: ${JSON.stringify(issue)}`);
  throw new Error(`Unable to create "${title}" issue.`);
}

async function updateIssue(octokit, issue, comment) {
  core.info(`\nAdding instructions to issue #${issue.data.number}...`);
  const result = await octokit.issues.createComment({
    owner: github.context.repo.owner,
    repo: github.context.repo.repo,
    issue_number: issue.data.number,
    body: comment
  });

  if (result.status != 201) {
    core.info(`Result: ${JSON.stringify(result)}`);
    throw new Error(`Unable to comment on issue #${issue.data.number}.`);
  }

  core.info(`Comment created at: ${result.data.html_url}`);

  core.info(`\nClosing issue #${issue.data.number}...`);
  const closed = await octokit.issues.update({
    owner: github.context.repo.owner,
    repo: github.context.repo.repo,
    issue_number: issue.data.number,
    state: 'closed'
  });

  if (closed.status != 200) {
    core.info(`Result: ${JSON.stringify(closed)}`);
    throw new Error(`Unable to close issue #${issue.data.number}.`);
  }
}

async function run() {
  try {
    const token = core.getInput('token');
    core.setSecret(token);

    const octokit = github.getOctokit(token);

    const states = {}; // values saved from setup
    utils.restoreStates(states);

    const project = getProject(states.release);
    const type = states.type;
    const title = `Project ${states.release} ${type} Grade`;

    const comment = `
## Student Instructions

Hello @${github.context.actor}! Please follow these instructions to request your project ${project} ${type.toLowerCase()} grade:

- [ ] Edit the issue body above and replace \`[FULL_NAME]\` with your full name and \`[USF_EMAIL]\` with your USF username so we can enter your grade on Canvas. (Make sure to remove the \`[\` and \`]\` symbols too.)

- [ ] Make sure the [labels, assignee, and milestone](https://guides.github.com/features/issues/) were autoassigned correctly. (If any of these are missing, reach out on the course forums.)

- [ ] Make sure the parsed dates and resulting grade were autocalculated correctly. It is possible the difference in time zones affected the math. If there is an error, please add a comment notifying us of the issue.

- [ ] **Re-open the issue when all of the above is complete.** :arrow_left:

Click each of the above tasks as you complete them!

We will reply and lock this issue once the grade is updated on Canvas. If we do not respond within 2 *business* days, please reach out on CampusWire.

:warning: **We will not see this issue and update your grade until you re-open it!**
    `;

    if (type == 'Functionality') {
      // -----------------------------------------------
      core.startGroup(`Checking for previous ${type.toLowerCase()} issues...`);
      core.info(`\nRequesting ${title}...`);

      const issues = await findIssues(octokit, project, type);
      const same = issues.find(x => x.title == title);

      if (same != undefined) {
        core.info(`Result: ${JSON.stringify(same)}`);
        throw new Error(`An issue titled "${title}" already exists. Fix or delete that issue to proceed.`);
      }

      if (issues.length > 0) {
        core.info(`Result: ${JSON.stringify(issues)}`);
        throw new Error(`Found ${issues.length} ${type.toLowerCase()} issue(s) for project ${project} already. Only one such issue should be required. Are you sure you need to create a new issue? Consider fixing or deleting the other issues instead!`);
      }
      else {
        core.info(`This appears to be the first project ${project} ${type.toLowerCase()} issue.`);
      }

      // TODO Check for verification of previous projects.
      core.info('');
      core.endGroup();

      // -----------------------------------------------
      const grade = calculateGrade(states.releaseDate, project, type);

      // -----------------------------------------------
      core.startGroup(`Creating functionality issue...`);

      const body = `
## Student Information

  - **Full Name:** [FULL_NAME]
  - **USF Email:** [USF_EMAIL]@usfca.edu

## Project Information

  - **Project:** Project ${project} ${constants.names[project]}
  - **${type} Deadline:** ${grade.deadline}

## Release Information

  - **Release:** [${states.release}](${states.releaseUrl})
  - **Release Verified:** [Run ${states.runNumber} (${states.runId})](${states.runUrl})
  - **Release Created:** ${grade.created}

## Grade Information

  - **Late Deduction:** \`${grade.deduction}\`
  - **Project ${type} Grade:** \`${grade.grade}%\` (before other deductions)

      `;

      const issue = await createIssue(octokit, project, type.toLowerCase(), title, body);

      await updateIssue(octokit, issue, comment);

      core.info('');
      core.endGroup();

      const message = `${type} issue #${issue.data.number} for project ${project} release ${states.release} created. Visit the issue for further instructions at: ${issue.data.html_url}`;
      utils.showSuccess(message);
      utils.showWarning(`Grade not yet updated! Visit the created issue for further instructions!`);
      core.notice(message);
    }
    else if (type == 'Design') {
      // -----------------------------------------------
      core.startGroup(`Checking for previous project ${project} issues...`);
      core.info(`\nRequesting ${title}...`);

      const issues = await findIssues(octokit, project, undefined);

      const pulls = []; // pull requests
      const extra = []; // extra issues

      let same = false;
      let functionality = undefined;

      for (const issue of issues) {
        // remove issue body (easier debugging)
        delete issue.body;

        if (issue.title == title) { // make sure duplicate doesn't exist
          same = true;
          break;
        }

        if ('pull_request' in issue) { // find the pull requests while at it
          pulls.push(issue);
          continue;
        }

        if (issue.state == 'closed' && issue.locked == true && issue.active_lock_reason == 'resolved') {
          if (issue.labels.some(label => label.name == 'functionality')) {
            functionality = issue;
            continue;
          }
        }

        extra.push(issue);
      }

      if (same) {
        core.info(`Result: ${JSON.stringify(same)}`);
        throw new Error(`An issue titled "${title}" already exists. Fix or delete that issue to proceed.`);
      }

      if (extra.length > 0) {
        core.info(`Result: ${JSON.stringify(extra)}`);
        throw new Error(`Found ${extra.length} extra issue(s) for project ${project} already. Are you sure you need to create a new issue? Consider fixing or deleting the other issues instead!`);
      }

      if (!functionality) {
        core.info(`Result: ${JSON.stringify(issues)}`);
        throw new Error(`Could not find an approved and locked functionality issue for project ${project}. If you have a functionality issue, contact the instructor or teacher assistant to make sure the issue is properly locked first.`);
      }

      states.issueNumber = functionality.number;
      states.issueUrl = functionality.html_url;

      core.info(`This appears to be the first project ${project} ${type.toLowerCase()} issue.`);

      core.info('');
      core.endGroup();

      core.startGroup(`Finding project ${project} pull requests...`);
      core.info('');

      // find all of the pull requests that were actually approved
      const approved = [];
      const unapproved = [];

      const rows = [
        '| Pull | Status | Version | Type | Approved | Passed? |',
        '|:----:|:------:|:-------:|:-----|:---------|:-------:|'
      ];

      for (const pull of pulls) {
        const reviews = await octokit.pulls.listReviews({
          owner: github.context.repo.owner,
          repo: github.context.repo.repo,
          pull_number: pull.number
        });

        if (reviews.status != 200) {
          core.info("Pull Request: " + JSON.stringify(pull));
          core.info("Reviews: " + JSON.stringify(reviews));
          core.warning(`Requesting review information failed.`);

          // add to list of unapproved for now
          unapproved.push(pull);
          continue;
        }

        const found = reviews.data.filter(x => x.state == "APPROVED" && x.user.login == "sjengle");

        if (found.length > 0) {
          pull.approved = found.slice(-1)[0];
          approved.push(pull);

          const status = pull.draft ? 'draft' : pull.state;
          const version = pull.labels.map(x => x.name).filter(x => x.startsWith('v')).pop();
          const pulltype = pull.labels.map(x => x.name).filter(x => x.endsWith('chronous')).pop();

          const createdDate = pull.created_at ? DateTime.fromISO(pull.created_at).setZone(zone).toLocaleString(DateTime.DATETIME_FULL) : 'N/A';
          const approvedDate = pull.approved ? DateTime.fromISO(pull.approved.submitted_at).setZone(zone).toLocaleString(DateTime.DATETIME_FULL) : 'N/A';
          const closedDate = pull.closed_at ? DateTime.fromISO(pull.closed_at).setZone(zone).toLocaleString(DateTime.DATETIME_FULL) : 'N/A';

          const passed = pull.labels.map(x => x.name).filter(x => x == 'passed').length > 0 ? ':ballot_box_with_check:' : '';

          rows.push(`| [#${pull.number}](${pull.html_url}) | ${status} | \`${version}\` | ${pulltype} | ${approvedDate} | ${passed} |`);
        }
        else {
          unapproved.push(pull);
        }
      }

      core.info("Approved: " + JSON.stringify(approved.map(x => x.number)));
      core.info("Unapproved: " + JSON.stringify(unapproved.map(x => x.number)));

      if (approved.length < 1) {
        core.info("Pulls: " + JSON.stringify(pulls));
        throw new Error(`Unable to find any approved pull requests for project ${project}. You must have at least one approved pull request to pass project design.`);
      }

      // TODO changed here
      states.approvedPull = approved.length > 0 ? approved[0].number : 'N/A';
      states.approvedDate = approved.length > 0 ? approved[0].approved.submitted_at : 'N/A';

      core.info('');
      core.info("First Approved Pull: " + states.approvedPull);
      core.info("First Approved Date: " + states.approvedDate);

      core.info('');
      core.endGroup();

      // -----------------------------------------------
      const grade = calculateGrade(states.approvedDate, project, type);

      // -----------------------------------------------
      core.startGroup(`Creating design issue...`);

      const body = `
## Student Information

  - **Full Name:** [FULL_NAME]
  - **USF Email:** [USF_EMAIL]@usfca.edu

## Project Information

  - **Project:** Project ${project} ${constants.names[project]}
  - **Project Functionality:** [Issue #${states.issueNumber}](${states.issueUrl})
  - **${type} Deadline:** ${grade.deadline}

## Release Information

  - **Release:** [${states.release}](${states.releaseUrl})
  - **Release Verified:** [Run ${states.runNumber} (${states.runId})](${states.runUrl})
  - **Release Created:** ${DateTime.fromISO(states.releaseDate).setZone(zone).toLocaleString(DateTime.DATETIME_FULL)}

## Grade Information

  - **Late Deduction:** \`${grade.deduction}\`
  - **Project ${type} Grade:** \`${grade.grade}%\` (before other deductions)

## Approved Pull Requests

${rows.join('\n')}

## Extra Requests

  - **Extra Issues:** ${extra.length > 0 ? extra.map(x => '#' + x.number).join(', ') : 'N/A'}
  - **Extra Pull Requests:** ${unapproved.length > 0 ? unapproved.map(x => '#' + x.number).join(', ') : 'N/A'}

${extra.length > 0 || unapproved.length > 0 ? ':warning: **Beware creating too many extra issues or pull requests for future projects!**' : ''}
      `;

      const issue = await createIssue(octokit, project, type.toLowerCase(), title, body);

      await updateIssue(octokit, issue, comment);

      core.info('');
      core.endGroup();

      const message = `${type} issue #${issue.data.number} for project ${project} release ${states.release} created. Visit the issue for further instructions at: ${issue.data.html_url}`;
      utils.showSuccess(message);
      utils.showWarning(`Grade not yet updated! Visit the created issue for further instructions!`);
      core.info(message);
    }
    else {
      core.startGroup('Handling unknown request...');
      throw new Error(`The value "${type}" is not a valid project grade type.`);
    }
  }
  catch (error) {
    // show error in group
    utils.showError(`${error.message}\n`);
    core.endGroup();

    // displays outside of group; always visible
    core.setFailed(`Unable to request project grade. ${error.message}`);
  }
}

run();
