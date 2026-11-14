@pbi-210
Feature: A merged cell-side change reaches new cells without restarting the factory
  Today `npm run factory` builds `factory-cell:local` from the operator's checkout once, at start. A change
  merged to `main` that only cells run, such as the SOP, a policy default, the cell engine or the factory's
  agents, reaches no cell until someone restarts the factory. With this item the factory checks `main` on
  each poll. When `main`'s new commits change only cell-side files, it rebuilds the cell image from `main`'s
  commit, without restarting the control plane, the worker or a running cell, and the next cell it starts
  uses the new image. It builds from the fetched commit and never from the operator's checkout, so local
  edits neither block the build nor end up in the image. The image records its commit, each rebuild logs
  an event naming the old and the new commit, and Floor shows the commit the cell image was built from.
  When the new commits also change code the control plane or the worker runs, the factory doesn't rebuild.
  Floor says a restart is needed instead, and names the commit a restart would pick up. A failed build
  keeps the current image, logs the error and tries again on a later poll. A cell already running finishes
  on the image it started with.
  Cell-side files are those only a cell runs, such as `sop/`, `policy/`, `cell/` and `src/cell/`. Files
  such as `src/scheduler/`, `src/worker/` and `src/control/` are ones the control plane or the worker runs.
  Unless a scenario is tagged @local, these scenarios run the factory against a fake `main`, a fake image
  builder and a fake cell launcher, so cells and CI both run them.

  Background:
    Given the cell image "factory-cell:local" was built from commit "aaa111"
    And the factory last saw `main` at commit "aaa111"

  Rule: New commits on main that change only cell-side files rebuild the cell image within one poll, with no restart

    @ac-1
    Scenario: A cell-side change on main rebuilds the cell image from main's commit on the next poll
      Given `main` gains commit "bbb222" that changes only "sop/sop.yml"
      When the factory polls once
      Then the cell image "factory-cell:local" has been rebuilt from commit "bbb222"
      And the control plane has not restarted
      And the worker has not restarted

    @ac-1
    Scenario: The next cell started after the rebuild runs the new image
      Given `main` gains commit "bbb222" that changes only "src/cell/engine.ts"
      And item "A" is queued
      When the factory polls once
      And the scheduler starts a cell for item "A"
      Then the cell for item "A" runs the cell image built from commit "bbb222"

    @ac-1
    Scenario: Several cell-side commits since the last poll rebuild once, from the newest commit
      Given `main` gains commit "bbb222" that changes only "policy/dor.md"
      And `main` then gains commit "ccc333" that changes only "cell/claude/agents/factory-pr-reviewer.md"
      When the factory polls once
      Then the cell image has been built exactly once
      And the cell image "factory-cell:local" has been rebuilt from commit "ccc333"

    @ac-1
    Scenario: A poll that finds main unchanged builds nothing
      Given `main` is still at commit "aaa111"
      When the factory polls once
      Then the cell image has not been built
      And the cell image "factory-cell:local" was built from commit "aaa111"

    @ac-1 @local
    Scenario: On the owner's machine, a merged cell-side change reaches the next cell under a running factory
      Given the factory is running under `aspire run`
      And a commit that changes only "sop/sop.yml" is merged to `main`
      When the factory polls once
      Then the Docker image "factory-cell:local" carries the merged commit
      And the `aspire run` session is the one that was already running
      And the next cell the factory starts runs that image

  Rule: The rebuild builds from the fetched commit and never touches the operator's checkout

    @ac-2
    Scenario: Uncommitted edits in the checkout neither block the rebuild nor reach the image
      Given the operator's checkout has an uncommitted edit to "sop/sop.yml"
      And `main` gains commit "bbb222" that changes only "policy/dor.md"
      When the factory polls once
      Then the cell image "factory-cell:local" has been rebuilt from commit "bbb222"
      And the image's "sop/sop.yml" matches commit "bbb222", not the checkout's edit
      And the operator's checkout still has its uncommitted edit to "sop/sop.yml"

    @ac-2
    Scenario: The rebuild leaves the checkout on its own branch and commit
      Given the operator's checkout is on branch "my-work" at commit "fff999"
      And `main` gains commit "bbb222" that changes only "src/cell/engine.ts"
      When the factory polls once
      Then the cell image "factory-cell:local" has been rebuilt from commit "bbb222"
      And the operator's checkout is still on branch "my-work" at commit "fff999"

    @ac-2
    Scenario: A local commit in the checkout that isn't on main never reaches the image
      Given the operator's checkout holds a local commit "eee555" that changes "src/cell/engine.ts" and isn't on `main`
      And `main` gains commit "bbb222" that changes only "sop/sop.yml"
      When the factory polls once
      Then the cell image "factory-cell:local" has been rebuilt from commit "bbb222"
      And the image's "src/cell/engine.ts" matches commit "bbb222", not commit "eee555"

  Rule: The image records the commit it was built from, each rebuild logs the old and the new commit, and Floor shows the image's commit

    @ac-3
    Scenario: The rebuilt image carries the commit it was built from
      Given `main` gains commit "bbb222" that changes only "sop/sop.yml"
      When the factory polls once
      Then the image "factory-cell:local" records that it was built from commit "bbb222"

    @ac-3
    Scenario: A rebuild logs an event naming the old and the new commit
      Given `main` gains commit "bbb222" that changes only "sop/sop.yml"
      When the factory polls once
      Then the event log holds one cell image rebuild event
      And that event names old commit "aaa111" and new commit "bbb222"

    @ac-3
    Scenario: Floor shows the commit the cell image was built from, before and after a rebuild
      Given Floor shows the cell image was built from commit "aaa111"
      And `main` gains commit "bbb222" that changes only "sop/sop.yml"
      When the factory polls once
      Then Floor shows the cell image was built from commit "bbb222"

  Rule: When main's new commits touch code the control plane or the worker runs, the factory doesn't rebuild and Floor asks for a restart

    @ac-4
    Scenario: A change to the scheduler holds the rebuild and Floor asks for a restart naming the commit
      Given `main` gains commit "bbb222" that changes "src/scheduler/scheduler.ts"
      When the factory polls once
      Then the cell image has not been built
      And the cell image "factory-cell:local" was built from commit "aaa111"
      And Floor says a restart is needed to pick up commit "bbb222"

    @ac-4
    Scenario: A commit that changes both cell-side and control plane files doesn't rebuild
      Given `main` gains commit "bbb222" that changes "sop/sop.yml" and "src/control/cell-api.ts"
      When the factory polls once
      Then the cell image has not been built
      And Floor says a restart is needed to pick up commit "bbb222"

    @ac-4
    Scenario: A cell-side commit after a control plane commit still doesn't rebuild, and Floor names the newest commit
      Given `main` gains commit "bbb222" that changes "src/worker/main.ts"
      And `main` then gains commit "ccc333" that changes only "sop/sop.yml"
      When the factory polls once
      Then the cell image has not been built
      And Floor says a restart is needed to pick up commit "ccc333"

    @ac-4
    Scenario: A change to shared code both sides run counts as control plane code
      Given `main` gains commit "bbb222" that changes "src/core/states.ts"
      When the factory polls once
      Then the cell image has not been built
      And Floor says a restart is needed to pick up commit "bbb222"

    @ac-4
    Scenario: Floor asks for no restart while main holds only cell-side changes
      Given `main` gains commit "bbb222" that changes only "sop/sop.yml"
      When the factory polls once
      Then Floor doesn't say a restart is needed

  Rule: A failed build keeps the current image, logs the error and tries again on a later poll

    @ac-5
    Scenario: A failed build keeps the image cells already use and logs the error
      Given `main` gains commit "bbb222" that changes only "sop/sop.yml"
      And building the cell image fails with "npm ci exited 1"
      When the factory polls once
      Then the cell image "factory-cell:local" was built from commit "aaa111"
      And the event log holds a failed cell image build event for commit "bbb222" naming "npm ci exited 1"
      And Floor shows the cell image was built from commit "aaa111"

    @ac-5
    Scenario: The next cell after a failed build starts on the image that was already there
      Given `main` gains commit "bbb222" that changes only "sop/sop.yml"
      And building the cell image fails with "npm ci exited 1"
      And item "A" is queued
      When the factory polls once
      And the scheduler starts a cell for item "A"
      Then the cell for item "A" runs the cell image built from commit "aaa111"

    @ac-5
    Scenario: The factory tries the build again on a later poll and succeeds
      Given `main` gains commit "bbb222" that changes only "sop/sop.yml"
      And building the cell image fails once with "network unreachable", then succeeds
      When the factory polls once
      And the factory polls again
      Then the cell image has been built twice
      And the cell image "factory-cell:local" has been rebuilt from commit "bbb222"
      And the event log holds a cell image rebuild event naming old commit "aaa111" and new commit "bbb222"

  Rule: A cell already running finishes on the image it started with

    @ac-6
    Scenario: A cell running during a rebuild is not stopped or restarted
      Given item "A" is running in cell "cell-a" on the cell image built from commit "aaa111"
      And `main` gains commit "bbb222" that changes only "sop/sop.yml"
      When the factory polls once
      Then the cell image "factory-cell:local" has been rebuilt from commit "bbb222"
      And cell "cell-a" has not been stopped or restarted
      And cell "cell-a" still runs the cell image built from commit "aaa111"

    @ac-6
    Scenario: A running cell and a new cell run side by side on the old and the new image
      Given item "A" is running in cell "cell-a" on the cell image built from commit "aaa111"
      And item "B" is queued
      And `main` gains commit "bbb222" that changes only "src/cell/engine.ts"
      When the factory polls once
      And the scheduler starts a cell for item "B"
      Then cell "cell-a" still runs the cell image built from commit "aaa111"
      And the cell for item "B" runs the cell image built from commit "bbb222"
