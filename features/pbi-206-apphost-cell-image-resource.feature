@pbi-206
Feature: The AppHost rebuilds factory-cell:local as a resource the worker waits on
  The worker's egress proxy and every cell run the image `factory-cell:local`. Today only `npm run factory` builds
  it from the checkout, in `scripts/factory.ps1`, before it calls `aspire run`. A plain `aspire run` builds nothing,
  so the worker can start on an image from an older checkout, or on no image at all.
  With this item the AppHost builds the image itself, as a resource of its own named "cell-image" in the Aspire
  dashboard. It builds from this checkout's files, as they are once the start's pull of `main` is done, with the
  checkout's `cell/Dockerfile`. The worker waits for that build to finish before it starts. When the build fails, the
  dashboard shows "cell-image" as failed, with the build's error in its log, and the worker never starts.
  As `npm run factory` does today, the image records the checkout's commit only when the checkout has no
  uncommitted edits. An image that holds uncommitted edits was built from no commit, so it records none.
  Once the worker is running it keeps the image current with `main`, as PBI 210 says. This item doesn't change that.
  Unless a scenario is tagged @local, these scenarios run the AppHost's start against a fake checkout, a fake Docker
  that records each build, and fake resources that record when they start, so cells and CI both run them. The
  scenarios tagged @local need Docker Desktop, the Aspire CLI and the owner's secrets, so the owner runs them and the
  PR records the run.

  Rule: The worker starts only once factory-cell:local has been rebuilt from this checkout

    @ac-1
    Scenario: A start rebuilds the cell image from the checkout, and the worker starts after it
      Given the checkout is at commit "aaa111" with no uncommitted edits
      When the AppHost starts
      Then the dashboard shows a resource named "cell-image"
      And "cell-image" built "factory-cell:local" from the checkout's files at commit "aaa111"
      And the image "factory-cell:local" records commit "aaa111"
      And "cell-image" shows as finished in the dashboard
      And the build of "factory-cell:local" finished before the worker started
      And the worker started

    @ac-1
    Scenario: The worker waits for a slow build to finish
      Given the checkout is at commit "aaa111" with no uncommitted edits
      And building "factory-cell:local" takes 4 minutes
      When the AppHost starts
      Then the worker had not started 3 minutes into the build
      And the worker started after the build of "factory-cell:local" finished

    @ac-1
    Scenario: A start rebuilds the image even when an older one is already there
      Given the image "factory-cell:local" already exists, built from commit "old000"
      And the checkout is at commit "aaa111" with no uncommitted edits
      When the AppHost starts
      Then "cell-image" built "factory-cell:local" from the checkout's files at commit "aaa111"
      And the image "factory-cell:local" records commit "aaa111"
      And the build of "factory-cell:local" finished before the worker started

    @ac-1
    Scenario: On main, the image is built from the commit the start's pull brought in
      Given the checkout is on branch "main" at commit "aaa111"
      And the remote's "main" is at commit "bbb222", which fast-forwards from "aaa111"
      When the AppHost starts
      Then the pull of "main" finished before the build of "factory-cell:local" started
      And the image "factory-cell:local" records commit "bbb222"
      And the build of "factory-cell:local" finished before the worker started

    @ac-1
    Scenario: On another branch, the image is built from that branch's checkout as it is
      Given the checkout is on branch "my-work" at commit "fff999" with no uncommitted edits
      When the AppHost starts
      Then "cell-image" built "factory-cell:local" from the checkout's files at commit "fff999"
      And the image "factory-cell:local" records commit "fff999"
      And the checkout is still on branch "my-work" at commit "fff999"

    @ac-1
    Scenario: An uncommitted edit goes into the image, and the image records no commit
      Given the checkout is on branch "my-work" at commit "fff999"
      And the checkout has an uncommitted edit to "sop/sop.yml"
      When the AppHost starts
      Then the image "factory-cell:local" holds the edited "sop/sop.yml"
      And the image "factory-cell:local" records no commit
      And the checkout still has its uncommitted edit to "sop/sop.yml"
      And the worker started after the build of "factory-cell:local" finished

    @ac-1
    Scenario: The image is built with the checkout's own cell Dockerfile
      Given the checkout's "cell/Dockerfile" differs from the one on "main"
      When the AppHost starts
      Then "cell-image" built "factory-cell:local" with the checkout's "cell/Dockerfile"

    @ac-1 @local
    Scenario: On the owner's machine, aspire run rebuilds the cell image before the worker starts
      Given the owner's checkout is on branch "main" with no uncommitted edits
      When the owner starts "aspire run"
      Then the Aspire dashboard shows "cell-image" finished before the worker shows as running
      And the image "factory-cell:local" on the owner's Docker records the checkout's commit

  Rule: A failed build shows as a failed resource, and the worker never starts

    @ac-1
    Scenario: A build that fails shows "cell-image" as failed, and the worker never starts
      Given the checkout is at commit "aaa111" with no uncommitted edits
      And building "factory-cell:local" fails with the error "failed to solve: npm ci did not complete successfully: exit code: 1"
      When the AppHost starts
      Then "cell-image" shows as failed in the dashboard
      And the log of "cell-image" shows "failed to solve: npm ci did not complete successfully: exit code: 1"
      And the worker never starts

    @ac-1
    Scenario: A failed build doesn't fall back to the image that was already there
      Given the image "factory-cell:local" already exists, built from commit "old000"
      And the checkout is at commit "aaa111" with no uncommitted edits
      And building "factory-cell:local" fails
      When the AppHost starts
      Then "cell-image" shows as failed in the dashboard
      And the worker never starts
      And the image "factory-cell:local" still records commit "old000"

    @ac-1
    Scenario: A build that can't reach Docker shows "cell-image" as failed, and the worker never starts
      Given the checkout is at commit "aaa111" with no uncommitted edits
      And Docker stops answering after the AppHost's Docker check
      When the AppHost starts
      Then "cell-image" shows as failed in the dashboard
      And the worker never starts

    @ac-1 @local
    Scenario: On the owner's machine, a broken cell Dockerfile shows "cell-image" failed, and the worker stays down
      Given the owner's checkout is on a branch whose "cell/Dockerfile" has a step that always fails
      When the owner starts "aspire run"
      Then the Aspire dashboard shows "cell-image" as failed, with Docker's error in its console
      And the Aspire dashboard never shows the worker as running
