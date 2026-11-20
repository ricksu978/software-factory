@pbi-208
Feature: aspire run is the one command that starts the factory
  Today the README tells the owner to start the factory with `npm run factory`, which runs `scripts/factory.ps1`.
  That script checks the branch, pulls `main` and brings Docker up, and then runs `aspire run`, whose AppHost does
  the same checks again (PBI 205). With this item `aspire run` from the repo root is the one command. It does the
  start's four checks itself, before any resource starts:
    1. It finds the checkout's branch.
    2. On `main` it pulls fast-forward-only. A pull that fails stops the start with git's own message. On any
       other branch, or on no branch, it warns that it runs the checkout as it is, and pulls nothing.
    3. It checks that Docker answers.
    4. When Docker doesn't answer, it launches Docker Desktop and waits up to 3 minutes for it. It stops the start
       when Docker Desktop isn't installed, or when Docker hasn't answered within 3 minutes.
  A test run is a start with FACTORY_FLOAT_PORTS set to 1, as the BDD suites for PBIs 6, 89 and 156 start the
  AppHost. A test run never pulls and never waits on a prompt, so a suite run on `main` never moves the checkout or
  hangs waiting for git credentials.
  Unless a scenario is tagged @local, these scenarios run the AppHost's start against the fake checkout, fake git,
  fake Docker, fake clock and fake resources that PBI 205's scenarios use, or they read the repo's own files, so
  cells and CI both run them. The scenarios tagged @local need Docker Desktop, the Aspire CLI and the owner's
  secrets, so the owner runs them and the PR records the run.

  Rule: aspire run does the four checks itself, with the same rules for when each one stops the start

    @ac-1
    Scenario: Nothing checks the branch, pulls main or checks Docker before aspire run begins
      Given the factory's start command, as the README's "Run it" section gives it
      When the owner starts the factory with it, on branch "main", behind the remote's "main"
      Then nothing pulled "main" before `aspire run` began
      And nothing checked Docker before `aspire run` began
      And "main" was pulled once in the whole start

    @ac-1 @regression
    Scenario: On main, the start pulls main's new commit before any resource starts
      Given the checkout is on branch "main" at commit "aaa111"
      And the remote's "main" is at commit "bbb222", which fast-forwards from "aaa111"
      When the AppHost starts
      Then the start ran a fast-forward-only pull of "main" before any resource started
      And control, the worker and migrate all started on commit "bbb222"

    @ac-1 @regression
    Scenario Outline: A start that isn't a test run pulls main, with FACTORY_FLOAT_PORTS <setting>
      Given the checkout is on branch "main" at commit "aaa111"
      And the remote's "main" is at commit "bbb222", which fast-forwards from "aaa111"
      And FACTORY_FLOAT_PORTS is <setting>
      When the AppHost starts
      Then the checkout is at commit "bbb222"

      Examples:
        | setting        |
        | unset          |
        | set to "0"     |

    @ac-1 @regression
    Scenario: A failed pull stops the start with git's message, and no resource starts
      Given the checkout is on branch "main" at commit "aaa111"
      And git's pull fails with the message "fatal: unable to access the remote: Could not resolve host"
      When the AppHost starts
      Then the start stops
      And the start shows "fatal: unable to access the remote: Could not resolve host"
      And no resource has started

    @ac-1 @regression
    Scenario: On another branch, the start warns, pulls nothing and goes on
      Given the checkout is on branch "my-work" at commit "fff999"
      When the AppHost starts
      Then the start shows a warning that it is on branch "my-work", not "main", so it runs as it is
      And the start ran no pull
      And control, the worker and migrate all started on commit "fff999"

    @ac-1 @regression
    Scenario: With Docker Desktop stopped, the start launches it and waits for Docker before any resource starts
      Given Docker doesn't answer
      And Docker Desktop is installed
      And Docker will answer 40 seconds after Docker Desktop is launched
      When the AppHost starts
      Then the start launched Docker Desktop once
      And no resource started before Docker answered
      And control, the worker and migrate all started

    @ac-1 @regression
    Scenario: Docker that hasn't answered within 3 minutes stops the start
      Given Docker doesn't answer
      And Docker Desktop is installed
      And Docker will not answer after Docker Desktop is launched
      When the AppHost starts
      Then the start stops after waiting 3 minutes
      And the start shows "Docker did not come up within 3 minutes."
      And no resource has started

    @ac-1 @regression
    Scenario: With Docker Desktop not installed, the start stops with the same message as before
      Given Docker doesn't answer
      And Docker Desktop is not installed
      When the AppHost starts
      Then the start stops
      And the start shows "Docker is not running, and Docker Desktop is not installed where this looks. Start Docker first."
      And no resource has started

    @ac-1 @regression @local
    Scenario: On the owner's machine, aspire run from the repo root pulls main and brings Docker up
      Given the owner's checkout is on branch "main", one merged commit behind the remote's "main"
      And the owner has quit Docker Desktop
      When the owner runs "aspire run" from the repo root
      Then the checkout is at the remote's "main" commit before any resource shows as starting in the Aspire dashboard
      And Docker Desktop starts
      And Postgres, Azurite, migrate, control and the worker all come up in the Aspire dashboard

  Rule: A test run never pulls and never waits on a prompt

    @ac-2
    Scenario: A test run on main pulls nothing, and the resources run the checkout as it is
      Given the checkout is on branch "main" at commit "aaa111"
      And the remote's "main" is at commit "bbb222", which fast-forwards from "aaa111"
      When a test run of the AppHost starts, with FACTORY_FLOAT_PORTS set to "1"
      Then the start ran no pull
      And the checkout is still on branch "main" at commit "aaa111"
      And control, the worker and migrate all started on commit "aaa111"

    @ac-2
    Scenario: A test run on main whose remote would ask for credentials never asks, and starts
      Given the checkout is on branch "main" at commit "aaa111"
      And the remote asks for a username and password before it answers
      When a test run of the AppHost starts, with FACTORY_FLOAT_PORTS set to "1"
      Then the start never asked for an answer
      And the start ran no pull
      And control, the worker and migrate all started on commit "aaa111"

    @ac-2
    Scenario: A test run on main with local edits leaves them alone
      Given the checkout is on branch "main" at commit "aaa111"
      And the checkout has an uncommitted edit to "sop/sop.yml"
      And the remote's "main" is at commit "bbb222", which also changes "sop/sop.yml"
      When a test run of the AppHost starts, with FACTORY_FLOAT_PORTS set to "1"
      Then the start did not stop
      And the start ran no pull
      And the checkout still has its uncommitted edit to "sop/sop.yml"

    @ac-2 @local
    Scenario: On the owner's machine, the PBI 6 suite's start leaves a main checkout where it was
      Given the owner's worktree is on branch "main", one merged commit behind the remote's "main"
      When the PBI 6 suite starts the AppHost as a test run, with no one at the console
      Then the control resource answers without anyone having answered a prompt
      And the worktree is still at the commit it was on before the suite started

  Rule: npm run factory is gone, or it runs aspire run and nothing else

    @ac-3
    Scenario: The project's npm scripts start nothing of their own before aspire run
      When the owner reads the project's npm scripts
      Then there is no "factory" script, or the "factory" script runs "aspire run" and nothing else

  Rule: The README and the plan name aspire run as the way to start the factory

    @ac-3
    Scenario: The README's "Run it" section starts the factory with aspire run
      When the owner reads the README's "Run it" section
      Then its command to start the factory is "aspire run"
      And the section doesn't name "npm run factory" or "scripts/factory.ps1"
      And the section says that "aspire run" itself pulls "main", only when on "main", and starts Docker Desktop

    @ac-3
    Scenario: The plan's Task 18 starts the factory with aspire run
      When the owner reads the step of the plan's Task 18 that starts the factory
      Then the step names "aspire run" as the way to start the factory
      And the step doesn't name "npm run factory" or "scripts/factory.ps1"

  Rule: The BDD suites that start the AppHost still pass

    @ac-4 @regression @local
    Scenario Outline: The <suite> scenarios that start the AppHost still pass
      Given the owner's machine has Docker Desktop, the Aspire CLI and the factory's secrets
      When the owner runs the <suite> scenarios that start the AppHost
      Then every one of them passes

      Examples:
        | suite   |
        | PBI 6   |
        | PBI 89  |
        | PBI 156 |
