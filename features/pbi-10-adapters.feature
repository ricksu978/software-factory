@pbi-10
Feature: Adapter interfaces, fake adapter and contract suite
  Every backlog adapter passes one shared contract suite, so the factory can swap the fake for GitHub
  without changing behaviour. The fake adapter keeps everything in memory, so these scenarios need
  no database and no network, and cells run them.

  @ac-1
  Scenario: The fake adapter passes every case in the shared contract suite
    When I run the shared contract suite against the fake adapter
    Then every contract case passes
    And the suite ran these cases:
      | case                                                       |
      | listEligible returns only open items with the opt-in label |
      | comment twice with one dedupe key leaves one comment       |
      | claim shows the in-progress marker and release clears it   |
      | setStatus round-trips through getItem                      |
      | parseWebhook on an unknown payload returns ignored         |
      | close shows closed through getItem                         |

  @ac-2
  Scenario: Commenting twice with the same dedupe key leaves one comment
    Given a fake backlog with an open item labelled "factory"
    When the factory comments "Ready for the factory" on the item with dedupe key "readiness:1"
    And the factory comments "Ready for the factory" on the item with dedupe key "readiness:1"
    Then the item has exactly 1 comment

  @ac-2
  Scenario: Comments with different dedupe keys are both kept
    Given a fake backlog with an open item labelled "factory"
    When the factory comments "Ready for the factory" on the item with dedupe key "readiness:1"
    And the factory comments "Ready for the factory" on the item with dedupe key "readiness:2"
    Then the item has exactly 2 comments

  @ac-3
  Scenario: Claiming an item shows the marker, and releasing it clears the marker
    Given a fake backlog with an open item labelled "factory"
    When the factory claims the item
    Then the item read back carries the label "factory:in-progress"
    When the factory releases the item
    Then the item read back doesn't carry the label "factory:in-progress"
    And the item read back carries the label "factory"
