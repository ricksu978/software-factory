@pbi-259
Feature: A network blip to GitHub is retried before it ends a stage
  A cell talks to the outside world two ways: it calls the cell API, which often asks GitHub in turn,
  and it runs git push and git fetch against GitHub. Today one failed try of either ends the stage's
  attempt. A short GitHub outage, a dropped connection or a proxy that answers 502 for a few seconds
  costs a whole attempt, and the attempt's message gives no hint that the network was at fault.
  Worse, when GitHub fails behind the cell API, the cell API answers 500, the same as for a bug of its
  own, so nobody can tell the two apart.
  With this item, the cell waits and tries again, at least 3 times over at least 2 minutes, when the
  cell API answers 5xx, when the connection fails or times out, and when git push or git fetch fails
  on a network error, a proxy 5xx or a timeout. The cell API answers 503 when GitHub is what failed.
  A call that still fails after its retries ends the attempt as today, and the attempt's message says
  it failed on a network or GitHub error after so many tries. A 4xx answer, such as the 400 for a
  commit that isn't on the run's branch, is never retried, and nor is a git failure that isn't the
  network's, such as a rejected push. The cell's lease renewal keeps its own tolerance of 3 minutes
  of failed renewals, which this item doesn't change.
  Scenarios tagged @db need Postgres, which each test starts for itself, so cells and CI both run
  them, against a fake repo host that stands in for GitHub. The rest run the cell against a fake cell
  API, a fake agent and a fake git remote, on a clock the test moves, so waiting minutes takes none.

  Rule: The cell retries a cell API call that answers 5xx, fails to connect or times out

    @ac-1
    Scenario Outline: A call that answers <answer> once is tried again and the stage carries on
      Given a run for item 482 at green
      And the cell API answers <answer> the first time the cell asks for checks on its commit
      And answers normally after that
      When the cell runs
      Then the cell asked for checks on that commit twice
      And the cell waited before asking again
      And the green attempt is not failed by that answer
      And the attempt's message says nothing about a network or GitHub error

      Examples:
        | answer |
        | 500    |
        | 502    |
        | 503    |
        | 504    |

    @ac-1
    Scenario Outline: A call whose connection <fault> is tried again and the stage carries on
      Given a run for item 482 at green
      And the cell's connection to the cell API <fault> the first time the cell asks for checks on its commit
      And the cell API answers normally after that
      When the cell runs
      Then the cell asked for checks on that commit twice
      And the cell waited before asking again
      And the green attempt is not failed by that fault

      Examples:
        | fault                                       |
        | is refused                                  |
        | is reset before the answer arrives          |
        | gets no answer within the cell's time limit |

    @ac-1
    Scenario Outline: Every call the cell makes to the cell API is retried in the same way
      Given a run for item 482 at green
      And the cell API answers 503 the first two times the cell makes the call "<call>"
      And answers normally after that
      When the cell runs as far as that call
      Then the cell made the call "<call>" three times
      And each of the three tries sent the same request
      And the cell carried on past that call

      Examples:
        | call                 |
        | GET /context         |
        | POST /github-token   |
        | POST /lease          |
        | POST /stage          |
        | POST /transition     |
        | POST /policy-results |
        | POST /pr             |
        | GET /checks          |
        | GET /ci-checks       |
        | POST /upload-url     |

    @ac-1
    Scenario: A call that fails for a while succeeds on a late retry, well after the first try
      Given a run for item 482 at green
      And the cell API answers 503 to every ask for checks on the cell's commit for the next 90 seconds
      And answers normally after that
      When the cell runs
      Then the cell asked again for checks until the cell API answered normally
      And the green attempt is not failed by those answers

    @ac-1
    Scenario: A call that never stops failing is tried at least 3 more times over at least 2 minutes before it ends the attempt
      Given a run for item 482 at green
      And the cell API answers 503 to every ask for checks on the cell's commit
      When the cell runs
      Then the cell asked for checks on that commit at least 4 times
      And the last ask came at least 2 minutes after the first
      And the cell waited before each ask after the first
      And only then did the green attempt end failed

  Rule: The cell retries git push and git fetch that fail on the network, a proxy 5xx or a timeout

    @ac-2
    Scenario Outline: A push that fails once because <fault> is tried again and goes through
      Given a run for item 482 at green
      And the cell's first git push fails because <fault>
      And git push goes through after that
      When the cell runs
      Then the cell ran git push twice
      And the cell waited before pushing again
      And the run's branch holds the cell's commit
      And the green attempt is not failed by that push

      Examples:
        | fault                                    |
        | GitHub's host name can't be resolved     |
        | the connection to GitHub is refused      |
        | the connection to GitHub is reset        |
        | the proxy answers 502                    |
        | the proxy answers 503                    |
        | the proxy answers 504                    |
        | the push doesn't finish within its limit |

    @ac-2
    Scenario Outline: A fetch of the base that fails once because <fault> is tried again and the merge goes ahead
      Given a run for item 482 at green
      And the cell's first git fetch of the base fails because <fault>
      And git fetch goes through after that
      When the cell runs
      Then the cell ran git fetch of the base twice
      And the cell waited before fetching again
      And the base was merged into the run's branch
      And the green attempt is not failed by that fetch

      Examples:
        | fault                                     |
        | GitHub's host name can't be resolved      |
        | the connection to GitHub is reset         |
        | the proxy answers 503                     |
        | the fetch doesn't finish within its limit |

    @ac-2
    Scenario: A push that never stops failing on the network is tried at least 3 more times over at least 2 minutes
      Given a run for item 482 at green
      And every git push the cell runs fails because the connection to GitHub is reset
      When the cell runs
      Then the cell ran git push at least 4 times
      And the last push came at least 2 minutes after the first
      And only then did the green attempt end failed

    @ac-2
    Scenario: A fetch that never stops failing on the network is tried at least 3 more times over at least 2 minutes
      Given a run for item 482 at green
      And every git fetch of the base the cell runs fails because the proxy answers 503
      When the cell runs
      Then the cell ran git fetch of the base at least 4 times
      And the last fetch came at least 2 minutes after the first
      And only then did the green attempt end failed

    @ac-2
    Scenario: A push GitHub rejects after a network failure isn't tried a third time
      Given a run for item 482 at green
      And the cell's first git push fails because the connection to GitHub is reset
      And its second git push is rejected because the run's branch moved on
      When the cell runs
      Then the cell ran git push exactly twice
      And the green attempt ends failed
      And the attempt's message says the push was rejected
      And the attempt's message doesn't say it failed on a network or GitHub error

  Rule: The cell API answers 503 when GitHub failed or timed out, and keeps 500 for its own faults

    @ac-3 @db
    Scenario Outline: GitHub answering <github> to the cell API's question for "<call>" gets the cell 503
      Given a fresh factory database where item "A" was claimed, so its run is in progress at lease generation 1
      And item "A"'s run has open PR 57 and a commit on its branch
      And GitHub answers <github> to every question the cell API asks it
      When the cell makes the call "<call>" with its token
      Then the cell API answers 503
      And the answer says GitHub failed

      Examples:
        | call               | github |
        | GET /checks        | 500    |
        | GET /checks        | 502    |
        | GET /ci-checks     | 503    |
        | POST /github-token | 502    |
        | GET /context       | 504    |

    @ac-3 @db
    Scenario Outline: GitHub being unreachable from the cell API for "<call>" gets the cell 503
      Given a fresh factory database where item "A" was claimed, so its run is in progress at lease generation 1
      And item "A"'s run has open PR 57 and a commit on its branch
      And the cell API's connection to GitHub <fault>
      When the cell makes the call "<call>" with its token
      Then the cell API answers 503
      And the answer says GitHub failed

      Examples:
        | call               | fault                                           |
        | GET /checks        | is refused                                      |
        | GET /ci-checks     | is reset                                        |
        | POST /github-token | gets no answer within the cell API's time limit |
        | GET /context       | gets no answer within the cell API's time limit |

    @ac-3 @db
    Scenario: A GitHub outage behind the cell API is one the cell retries, and the stage carries on once GitHub is back
      Given a fresh factory database where item "A" was claimed, so its run is in progress at lease generation 1
      And item "A"'s run has open PR 57 and a commit on its branch
      And GitHub answers 502 to the cell API's first question about checks on that commit
      And answers normally after that
      When the cell asks the cell API for checks on that commit
      Then the cell API's first answer was 503
      And the cell asked again
      And the cell got the commit's checks

  Rule: A call still failing after its retries ends the attempt as today, saying it was the network or GitHub, after how many tries

    @ac-4
    Scenario: The cell API failing on every try ends the attempt, naming a GitHub error and the number of tries
      Given a run for item 482 at green
      And the cell API answers 503 to every ask for checks on the cell's commit
      When the cell runs
      Then the green attempt ends failed, as an attempt ends on any other error today
      And the attempt's message names the call for checks
      And the attempt's message says it failed on a network or GitHub error after the number of tries the cell made
      And the owner is asked no question
      And the cell reports no move for the item

    @ac-4
    Scenario: A connection to the cell API failing on every try ends the attempt, naming a network error and the number of tries
      Given a run for item 482 at green
      And the cell's connection to the cell API is refused every time the cell asks for checks on its commit
      When the cell runs
      Then the green attempt ends failed, as an attempt ends on any other error today
      And the attempt's message says it failed on a network or GitHub error after the number of tries the cell made

    @ac-4
    Scenario: A push failing on the network every try ends the attempt, naming a network error and the number of tries
      Given a run for item 482 at green
      And every git push the cell runs fails because GitHub's host name can't be resolved
      When the cell runs
      Then the green attempt ends failed, as an attempt ends on any other error today
      And the attempt's message names git push
      And the attempt's message says it failed on a network or GitHub error after the number of tries the cell made
      And the owner is asked no question

    @ac-4
    Scenario: A fetch failing on a proxy 5xx every try ends the attempt, naming a network error and the number of tries
      Given a run for item 482 at green
      And every git fetch of the base the cell runs fails because the proxy answers 502
      When the cell runs
      Then the green attempt ends failed, as an attempt ends on any other error today
      And the attempt's message names git fetch
      And the attempt's message says it failed on a network or GitHub error after the number of tries the cell made

  Rule: A 4xx answer is never retried, even after a retry

    @ac-5
    Scenario: The 400 for a commit that isn't on the run's branch, after a 503, ends the asking at once
      Given a run for item 482 at green
      And the cell API answers 503 the first time the cell asks for checks on its commit
      And answers 400, saying the commit isn't on the run's branch, the second time
      When the cell runs
      Then the cell asked for checks on that commit exactly twice
      And the green attempt ends failed
      And the attempt's message says the commit isn't on the run's branch
      And the attempt's message doesn't say it failed on a network or GitHub error

    @ac-5
    Scenario Outline: A <answer> after a 503 is not retried
      Given a run for item 482 at green
      And the cell API answers 503 the first time the cell asks for checks on its commit
      And answers <answer> the second time
      When the cell runs
      Then the cell asked for checks on that commit exactly twice
      And the green attempt ends failed
      And the attempt's message doesn't say it failed on a network or GitHub error

      Examples:
        | answer |
        | 400    |
        | 401    |
        | 403    |
        | 404    |

    @ac-5
    Scenario: A 409 after a 503 stops the cell at once, because the lease moved on
      Given a run for item 482 at green
      And the cell API answers 503 the first time the cell asks for checks on its commit
      And answers 409 the second time, because the run's lease generation moved on
      When the cell runs
      Then the cell asked for checks on that commit exactly twice
      And the cell ends stopped
      And the cell pushes nothing more and makes no further call
