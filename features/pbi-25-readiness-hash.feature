@pbi-25
Feature: Length-prefixed readiness hash
  The factory fingerprints the six files the readiness check reads, and a new fingerprint re-gates
  every NotReady item. Two different sets of files must never share a fingerprint, or a real fix to a
  policy file could go unnoticed. So each file counts within its own bounds, and text can't slide
  from one file into the next. A missing file counts as missing, never as a file that happens to
  hold the word "absent". None of these scenarios needs a database.

  @ac-1
  Scenario Outline: Text that moves across a file boundary changes the fingerprint
    Given one set of readiness files where <first> holds "<first text>" and <second> holds "<second text>"
    And another set where <first> holds "<other first text>" and <second> holds "<other second text>"
    Then the two sets have different fingerprints

    Examples:
      | first   | second       | first text | second text | other first text | other second text |
      | dor.md  | scenarios.md | ab         | c           | a                | bc                |
      | risk.md | dod.md       | x          |             |                  | x                 |

  @ac-2
  Scenario Outline: A missing file and a file holding the word "absent" have different fingerprints
    Given one set of readiness files with no <file>
    And another set where <file> holds "absent"
    Then the two sets have different fingerprints

    Examples:
      | file       |
      | dod.md     |
      | config.yml |

  @ac-3
  Scenario: The same files give the same fingerprint
    Given one set of readiness files
    And another set with the same files
    Then the two sets have the same fingerprint

  @ac-3
  Scenario Outline: Changing any one file changes the fingerprint
    Given one set of readiness files
    And another set where only <file> differs
    Then the two sets have different fingerprints

    Examples:
      | file         |
      | dor.md       |
      | scenarios.md |
      | pr-review.md |
      | risk.md      |
      | dod.md       |
      | config.yml   |

  @ac-3
  Scenario: A missing dod.md and an empty one have different fingerprints
    Given one set of readiness files with no dod.md
    And another set where dod.md holds ""
    Then the two sets have different fingerprints
