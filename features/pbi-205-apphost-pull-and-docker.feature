@pbi-205
Feature: The AppHost pulls main and starts Docker Desktop before any resource starts
  Today only `npm run factory` pulls the latest `main` and starts Docker Desktop, in `scripts/factory.ps1`.
  A plain `aspire run` does neither. It can start control, the worker and migrate on stale code, and with
  Docker Desktop stopped its containers never come up. With this item the AppHost does both itself,
  before any resource starts, however it was launched.
  On `main` a start runs a fast-forward-only pull, so control, the worker and migrate run the code it pulled.
  A pull that fails stops the start, shows git's own message, and starts no resource. On any other branch a
  start warns that it runs the checkout as it is, and pulls nothing.
  When Docker doesn't answer, the start launches Docker Desktop and waits up to 3 minutes for it. When Docker
  Desktop isn't installed, the start stops with the message `npm run factory` shows today:
  "Docker is not running, and Docker Desktop is not installed where this looks. Start Docker first."
  Unless a scenario is tagged @local, these scenarios run the AppHost's start against a fake checkout,
  fake git, fake Docker, a fake clock, and fake resources that record the commit they started on, so cells
  and CI both run them. The scenarios tagged @local need Docker Desktop, the Aspire CLI and the owner's
  secrets, so the owner runs them and the PR records the run.

  Rule: On main, a start fast-forwards before control, the worker or migrate starts

    @ac-1
    Scenario: A start on main pulls main's new commit, and the resources run it
      Given the checkout is on branch "main" at commit "aaa111"
      And the remote's "main" is at commit "bbb222", which fast-forwards from "aaa111"
      When the AppHost starts
      Then the checkout is at commit "bbb222"
      And migrate started on commit "bbb222"
      And control started on commit "bbb222"
      And the worker started on commit "bbb222"

    @ac-1
    Scenario: The pull finishes before any resource starts
      Given the checkout is on branch "main" at commit "aaa111"
      And the remote's "main" is at commit "bbb222", which fast-forwards from "aaa111"
      When the AppHost starts
      Then the pull of "main" finished before migrate started
      And the pull of "main" finished before control started
      And the pull of "main" finished before the worker started

    @ac-1
    Scenario: A start on main that is already up to date still checks main, then starts the resources
      Given the checkout is on branch "main" at commit "aaa111"
      And the remote's "main" is also at commit "aaa111"
      When the AppHost starts
      Then the start ran a fast-forward-only pull of "main" before any resource started
      And the checkout is at commit "aaa111"
      And control, the worker and migrate all started

    @ac-1
    Scenario: A start on main never merges a main that has diverged
      Given the checkout is on branch "main" with a local commit "ccc333" the remote doesn't have
      And the remote's "main" is at commit "bbb222", which doesn't fast-forward from "ccc333"
      When the AppHost starts
      Then the start stops with git's message about the failed pull
      And the checkout is still at commit "ccc333"
      And the checkout has no merge commit
      And no resource has started

    @ac-1
    Scenario: A failed pull stops the start and shows git's message
      Given the checkout is on branch "main" at commit "aaa111"
      And git's pull fails with the message "fatal: unable to access the remote: Could not resolve host"
      When the AppHost starts
      Then the start stops
      And the start shows "fatal: unable to access the remote: Could not resolve host"
      And no resource has started

    @ac-1
    Scenario: A pull that local edits would overwrite stops the start and leaves the edits alone
      Given the checkout is on branch "main" at commit "aaa111"
      And the checkout has an uncommitted edit to "sop/sop.yml"
      And the remote's "main" is at commit "bbb222", which also changes "sop/sop.yml"
      When the AppHost starts
      Then the start stops with git's message about the failed pull
      And the checkout still has its uncommitted edit to "sop/sop.yml"
      And no resource has started

    @ac-1 @local
    Scenario: On the owner's machine, aspire run on main runs the code just merged to main
      Given the owner's checkout is on branch "main", one merged commit behind the remote's "main"
      When the owner starts "aspire run"
      Then the checkout is at the remote's "main" commit before any resource shows as starting in the Aspire dashboard
      And control, the worker and migrate run that commit

  Rule: On any other branch, a start warns and pulls nothing

    @ac-2
    Scenario: A start on another branch warns and runs the checkout as it is
      Given the checkout is on branch "my-work" at commit "fff999"
      And the remote's "main" is at commit "bbb222"
      When the AppHost starts
      Then the start shows a warning that it is on branch "my-work", not "main", so it runs as it is
      And the start ran no pull
      And the checkout is still on branch "my-work" at commit "fff999"
      And control, the worker and migrate all started on commit "fff999"

    @ac-2
    Scenario: A start on another branch leaves the checkout's uncommitted edits alone
      Given the checkout is on branch "my-work" at commit "fff999"
      And the checkout has an uncommitted edit to "sop/sop.yml"
      When the AppHost starts
      Then the start shows a warning that it is on branch "my-work", not "main", so it runs as it is
      And the start ran no pull
      And the checkout still has its uncommitted edit to "sop/sop.yml"

    @ac-2
    Scenario: A start on a detached commit warns and pulls nothing
      Given the checkout is on no branch, at commit "fff999"
      When the AppHost starts
      Then the start shows a warning that it is not on "main", so it runs as it is
      And the start ran no pull
      And the checkout is still at commit "fff999"

  Rule: A start with Docker Desktop stopped starts it and waits up to 3 minutes

    @ac-3
    Scenario: A start with Docker answering checks Docker and goes on without launching Docker Desktop
      Given Docker answers
      When the AppHost starts
      Then the start checked that Docker answers before any resource started
      And the start did not launch Docker Desktop
      And control, the worker and migrate all started

    @ac-3
    Scenario: A start with Docker Desktop stopped launches it, and the resources start once Docker answers
      Given Docker doesn't answer
      And Docker Desktop is installed
      And Docker will answer 40 seconds after Docker Desktop is launched
      When the AppHost starts
      Then the start shows that it is starting Docker Desktop
      And the start launched Docker Desktop once
      And no resource started before Docker answered
      And control, the worker and migrate all started

    @ac-3
    Scenario: Docker Desktop that answers just inside 3 minutes is waited for
      Given Docker doesn't answer
      And Docker Desktop is installed
      And Docker will answer 2 minutes 50 seconds after Docker Desktop is launched
      When the AppHost starts
      Then the start did not stop
      And control, the worker and migrate all started

    @ac-3
    Scenario: Docker Desktop that doesn't answer within 3 minutes stops the start
      Given Docker doesn't answer
      And Docker Desktop is installed
      And Docker will not answer after Docker Desktop is launched
      When the AppHost starts
      Then the start stops after waiting 3 minutes
      And the start shows "Docker did not come up within 3 minutes."
      And no resource has started

    @ac-3
    Scenario: With Docker Desktop not installed, the start stops with the same message as today
      Given Docker doesn't answer
      And Docker Desktop is not installed
      When the AppHost starts
      Then the start stops
      And the start shows "Docker is not running, and Docker Desktop is not installed where this looks. Start Docker first."
      And the start did not launch Docker Desktop
      And no resource has started

    @ac-3 @local
    Scenario: On the owner's machine, aspire run with Docker Desktop quit starts it and brings the factory up
      Given the owner has quit Docker Desktop
      When the owner starts "aspire run"
      Then Docker Desktop starts
      And Postgres, Azurite, migrate, control and the worker all come up in the Aspire dashboard
