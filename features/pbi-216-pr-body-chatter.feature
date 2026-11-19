@pbi-216
Feature: Open-pr strips agent chatter from the PR body and requires it to start with "## Problem"
  Open-pr asks the agent for the summary part of the PR body, starting with a "## Problem" section.
  Today the factory puts the agent's whole reply at the top of the PR body, as it is. So a reply
  that opens with "Here is the PR body:", or that wraps the body in a fenced block and adds a line
  after it, puts that chatter in front of the person who merges.
  With this item, the factory cleans the reply before it writes the body. When the reply wraps the
  body in one fenced block, only the fence's contents are kept. When text comes before the first
  "## " heading, the body starts at that heading. A reply that, after both, still doesn't start with
  a "## Problem" heading fails the open-pr attempt with a finding that says so, and the next attempt
  tells the agent to reply with the body alone. A reply that already starts with "## Problem" is used
  unchanged. The PR review stage writes the body again from the same stored summary once its review
  passes, and that body is clean too.
  The scenarios run against a fake control plane, a fake agent and a fake repo host, so cells run
  them all. The "summary" is the agent's reply to open-pr. The "summary part" of the PR body is what
  comes before the factory's own "Refs #482" line.

  Background:
    Given a run for item 482 that resumes at open-pr
    And CI passes on every commit

  Rule: A summary wrapped in one fenced block keeps only the fence's contents

    @ac-1
    Scenario: Chatter before and after a fenced body is left out of the PR body
      Given the open-pr agent replies with this summary:
        """
        Here is the PR body you asked for:

        ```markdown
        ## Problem

        Orders over 100 items time out.

        ## What changes

        Orders are saved in batches.
        ```

        Let me know if you want any changes.
        """
      When the cell runs
      Then the summary part of the PR body is:
        """
        ## Problem

        Orders over 100 items time out.

        ## What changes

        Orders are saved in batches.
        """
      And the PR body doesn't hold "Here is the PR body you asked for:"
      And the PR body doesn't hold "Let me know if you want any changes."
      And the PR body doesn't hold "```"

    @ac-1
    Scenario: A fenced body with no language name is unwrapped too
      Given the open-pr agent replies with this summary:
        """
        Sure.

        ```
        ## Problem

        Orders over 100 items time out.
        ```
        """
      When the cell runs
      Then the summary part of the PR body is:
        """
        ## Problem

        Orders over 100 items time out.
        """
      And the PR body doesn't hold "Sure."
      And the PR body doesn't hold "```"

    @ac-1
    Scenario: The PR opens from a fenced summary without a failed open-pr attempt
      Given the open-pr agent replies with "## Problem" and the body wrapped in one fenced block, with a line of chatter before it
      When the cell runs
      Then the summary part of the PR body starts with "## Problem"
      And the open-pr stage ran 1 attempt
      And the open-pr stage passed

  Rule: Text before the summary's first "## " heading is left out of the PR body

    @ac-2
    Scenario: A line of chatter before the first heading is dropped
      Given the open-pr agent replies with this summary:
        """
        I've reviewed the diff. Here's the summary:

        ## Problem

        Orders over 100 items time out.

        ## What changes

        Orders are saved in batches.
        """
      When the cell runs
      Then the summary part of the PR body starts with "## Problem"
      And the PR body doesn't hold "I've reviewed the diff."
      And the PR body holds "Orders are saved in batches."

    @ac-2
    Scenario: Several paragraphs before the first heading are all dropped
      Given the open-pr agent replies with this summary:
        """
        Let me look at the branch first.

        I ran git log and git diff against the base.

        ## Problem

        Orders over 100 items time out.
        """
      When the cell runs
      Then the summary part of the PR body starts with "## Problem"
      And the PR body doesn't hold "Let me look at the branch first."
      And the PR body doesn't hold "I ran git log and git diff against the base."

    @ac-2
    Scenario: Text after the first heading stays, even a later "## " heading's section
      Given the open-pr agent replies with this summary:
        """
        Done.

        ## Problem

        Orders over 100 items time out.

        ## What changes

        Orders are saved in batches. Read `src/orders/save.ts` first.
        """
      When the cell runs
      Then the summary part of the PR body is:
        """
        ## Problem

        Orders over 100 items time out.

        ## What changes

        Orders are saved in batches. Read `src/orders/save.ts` first.
        """

    @ac-2
    Scenario: Chatter inside a fenced block before its first heading is dropped as well
      Given the open-pr agent replies with this summary:
        """
        ```markdown
        PR body below.

        ## Problem

        Orders over 100 items time out.
        ```
        """
      When the cell runs
      Then the summary part of the PR body is:
        """
        ## Problem

        Orders over 100 items time out.
        """

  Rule: A summary that still doesn't start with "## Problem" fails the attempt, and the retry asks for the body alone

    @ac-3
    Scenario: A summary whose first heading isn't "## Problem" fails the open-pr attempt
      Given the open-pr agent's first reply is this summary:
        """
        ## What changes

        Orders are saved in batches.
        """
      And the open-pr agent's second reply starts with "## Problem"
      When the cell runs
      Then the open-pr stage's first attempt ends failed
      And that attempt's finding says the PR body must start with a "## Problem" heading
      And no PR was opened with "## What changes" at the start of its body

    @ac-3
    Scenario: A summary with no "## " heading at all fails the open-pr attempt
      Given the open-pr agent's first reply is "I couldn't find anything to summarise on this branch."
      And the open-pr agent's second reply starts with "## Problem"
      When the cell runs
      Then the open-pr stage's first attempt ends failed
      And that attempt's finding says the PR body must start with a "## Problem" heading
      And no PR body holds "I couldn't find anything to summarise on this branch."

    @ac-3
    Scenario: A "### Problem" or "# Problem" heading isn't a "## Problem" heading
      Given the open-pr agent's first reply is this summary:
        """
        # Problem

        Orders over 100 items time out.
        """
      And the open-pr agent's second reply starts with "## Problem"
      When the cell runs
      Then the open-pr stage's first attempt ends failed
      And that attempt's finding says the PR body must start with a "## Problem" heading

    @ac-3
    Scenario: The retry tells the agent to reply with the PR body alone
      Given the open-pr agent's first reply is this summary:
        """
        ## What changes

        Orders are saved in batches.
        """
      And the open-pr agent's second reply starts with "## Problem"
      When the cell runs
      Then the open-pr agent's second brief says its last attempt failed because the PR body must start with a "## Problem" heading
      And the open-pr agent's second brief tells it to reply with the PR body alone, with nothing before or after it
      And the summary part of the PR body starts with "## Problem"
      And the open-pr stage passed

  Rule: A summary that already starts with "## Problem" reaches the PR body unchanged

    @ac-4 @regression
    Scenario: A clean summary is used exactly as written
      Given the open-pr agent replies with this summary:
        """
        ## Problem

        Orders over 100 items time out.

        ## What changes

        Orders are saved in batches. Read `src/orders/save.ts` first.

        ```ts
        await saveInBatches(order, 50);
        ```
        """
      When the cell runs
      Then the summary part of the PR body is:
        """
        ## Problem

        Orders over 100 items time out.

        ## What changes

        Orders are saved in batches. Read `src/orders/save.ts` first.

        ```ts
        await saveInBatches(order, 50);
        ```
        """
      And the open-pr stage ran 1 attempt

    @ac-4 @regression
    Scenario: A clean summary that mentions "## " inside its text keeps that text
      Given the open-pr agent replies with this summary:
        """
        ## Problem

        The release notes heading "## Fixes" is missing.
        """
      When the cell runs
      Then the summary part of the PR body is:
        """
        ## Problem

        The release notes heading "## Fixes" is missing.
        """

  Rule: The body the PR review stage writes again is clean too

    @ac-5
    Scenario: After a passing PR review, the rewritten body has no chatter
      Given the open-pr agent replies with this summary:
        """
        Here is the PR body you asked for:

        ```markdown
        ## Problem

        Orders over 100 items time out.
        ```

        Let me know if you want any changes.
        """
      And the PR reviewer approves on its first review
      When the cell runs
      Then the PR body holds "PR review took 1 round."
      And the summary part of the PR body is:
        """
        ## Problem

        Orders over 100 items time out.
        """
      And the PR body doesn't hold "Here is the PR body you asked for:"
      And the PR body doesn't hold "Let me know if you want any changes."
      And no body the factory wrote for the PR holds "Here is the PR body you asked for:"

    @ac-5
    Scenario: After several PR review rounds, the rewritten body still starts with "## Problem"
      Given the open-pr agent replies with this summary:
        """
        I've reviewed the diff. Here's the summary:

        ## Problem

        Orders over 100 items time out.
        """
      And the PR reviewer reports a finding "This misses the VAT." on line 12 of "src/totals.ts" on its first review
      And the PR addresser fixes it with a new commit
      And the PR reviewer finds that thread fixed on its second review, with no new finding
      When the cell runs
      Then the PR body holds "PR review took 2 rounds."
      And the summary part of the PR body starts with "## Problem"
      And no body the factory wrote for the PR holds "I've reviewed the diff."
