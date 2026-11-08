@pbi-96
Feature: A branch's own agent files don't replace the factory's reviewer and addresser in a cell
  The self-review and address stages each run one of the factory's own agents: the reviewer
  "factory-self-reviewer" and the addresser "factory-pr-addresser". The cell installs both for its
  own user. A checkout can hold agent files of the same names under ".claude/agents/", either because
  the repo is the factory itself or because a branch added them. Until now the checkout's file won,
  so a branch could hand the reviewer an Edit tool or tell the addresser to do something else. Now
  both stages run the factory's own definitions, whatever the checkout holds.
  In each scenario the checkout's file and the factory's file say different things, so the
  scenario can tell which of the two a stage ran.

  Rule: The self-review stage runs the factory's own reviewer

    @ac-1
    Scenario: A checkout's reviewer file doesn't replace the factory's reviewer
      Given a checkout holding its own "factory-self-reviewer" agent file, whose instructions differ from the factory's
      When the self-review stage sets up its agent run in that checkout
      Then the reviewer the run gets has the factory's instructions
      And the reviewer the run gets doesn't have the checkout's instructions

    @ac-1
    Scenario: A checkout's reviewer file can't give the reviewer tools to change files
      Given a checkout holding its own "factory-self-reviewer" agent file, which grants the tools "Read, Edit, Write, Bash"
      When the self-review stage sets up its agent run in that checkout
      Then the reviewer the run gets has the tools "Read, Grep, Glob, Bash"
      And the reviewer the run gets has no Edit or Write tool

  Rule: The address stage runs the factory's own addresser

    @ac-1
    Scenario: A checkout's addresser file doesn't replace the factory's addresser
      Given a checkout holding its own "factory-pr-addresser" agent file, whose instructions differ from the factory's
      When the address stage sets up its agent run in that checkout
      Then the addresser the run gets has the factory's instructions
      And the addresser the run gets doesn't have the checkout's instructions

  Rule: A checkout holding both files gets the factory's definitions for both stages

    @ac-1
    Scenario: A checkout with both agent files still runs the factory's reviewer and addresser
      Given a checkout holding its own "factory-self-reviewer" and "factory-pr-addresser" agent files, whose instructions differ from the factory's
      When the self-review stage and the address stage each set up their agent run in that checkout
      Then the self-review stage's reviewer has the factory's reviewer instructions
      And the address stage's addresser has the factory's addresser instructions
      And neither stage's agent has the checkout's instructions
