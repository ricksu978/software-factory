@pbi-84
Feature: Azurite runs on its own account key, so a cell can't forge a SAS
  Under `aspire run` today, Azurite runs on the development account key that Microsoft publishes for
  `devstoreaccount1`. Anyone can look that key up, so code in a cell can sign its own SAS for any blob, and the
  egress proxy forwards it, because it lets through any blob request that carries a SAS. A cell could then read
  other runs' logs or overwrite them.
  With this item, Azurite runs on an account key of its own, and `FACTORY_BLOB` hands that key to the control
  plane, so only the control plane can sign. A SAS signed with the published key gets 403. The write-only upload
  URLs the cell API hands out keep working from inside a cell container.
  The @ac-1 scenarios read the AppHost's wiring without starting it: they run the AppHost against a stand-in for
  Aspire that records the key each resource is given, so cells and CI run them. The @ac-2 and @ac-3 scenarios need
  a live Azurite, so they need Docker, the Aspire CLI and the owner's secrets, and are tagged @local: CI and cells
  skip them, the owner runs them, and the PR records the run.

  Rule: Under aspire run, Azurite's account key is not the published development key, and FACTORY_BLOB carries the same key

    @ac-1
    Scenario: The AppHost gives Azurite an account key of its own
      When the AppHost's wiring for "aspire run" is read without starting it
      Then the Azurite container is given an account key
      And that account key is not the published development key
      And that account key is not empty

    @ac-1
    Scenario: The control plane's FACTORY_BLOB carries the key Azurite is given
      When the AppHost's wiring for "aspire run" is read without starting it
      Then the control resource's "FACTORY_BLOB" carries the same account key as the Azurite container
      And the account key in the control resource's "FACTORY_BLOB" is not the published development key

    @ac-1
    Scenario: The cell API and the worker get the same key as Azurite and control
      When the AppHost's wiring for "aspire run" is read without starting it
      Then the "FACTORY_BLOB" of the control, cell API and worker resources all carry the Azurite container's account key
      And none of them carries the published development key

    @ac-1
    Scenario: A test run with floating ports still gives Azurite its own key
      Given ports float, as they do for a test run
      When the AppHost's wiring for "aspire run" is read without starting it
      Then the Azurite container is given an account key that is not the published development key
      And the control resource's "FACTORY_BLOB" carries the same account key as the Azurite container

  Rule: A SAS a cell signs with the published key is refused

    @ac-2 @local @serial
    Scenario: A cell's own write SAS, signed with the published key, gets 403
      Given "aspire run" is up and the image "factory-cell:local" is built
      And a "factory-cell:local" container has signed its own write SAS for a blob under "runs", with the published development key
      When the container PUTs a blob to that SAS URL through the egress proxy
      Then the response status is 403
      And no such blob exists in Azurite

    @ac-2 @local @serial
    Scenario: A cell's own read SAS, signed with the published key, can't read another run's log
      Given "aspire run" is up and the image "factory-cell:local" is built
      And a run's log has been uploaded to Azurite
      And a "factory-cell:local" container has signed its own read SAS for that log, with the published development key
      When the container GETs that SAS URL through the egress proxy
      Then the response status is 403
      And the response does not contain the log's text

    @ac-2 @local @serial
    Scenario: A cell's own write SAS, signed with the published key, can't overwrite an existing blob
      Given "aspire run" is up and the image "factory-cell:local" is built
      And a run's log has been uploaded to Azurite
      And a "factory-cell:local" container has signed its own write SAS for that log, with the published development key
      When the container PUTs "forged" to that SAS URL through the egress proxy
      Then the response status is 403
      And the log in Azurite still holds its original text

    @ac-2 @local @serial
    Scenario: A cell's own account-wide SAS, signed with the published key, can't list the containers
      Given "aspire run" is up and the image "factory-cell:local" is built
      And a "factory-cell:local" container has signed its own account SAS that allows listing, with the published development key
      When the container lists the blob containers with that SAS through the egress proxy
      Then the response status is 403

  Rule: The cell API's write-only upload URLs still work from inside a cell

    @ac-3 @local @regression @serial
    Scenario: A cell container uploads to a write-only URL from the cell API
      Given "aspire run" is up and the image "factory-cell:local" is built
      And a "factory-cell:local" container has asked the cell API for an upload URL for its run's log
      When the container PUTs the log to that upload URL through the egress proxy
      Then the response status is 201
      And the control plane reads back the same log from Azurite

    @ac-3 @local @regression @serial
    Scenario: The upload URL from the cell API still can't read the blob back
      Given "aspire run" is up and the image "factory-cell:local" is built
      And a "factory-cell:local" container has uploaded its run's log to an upload URL from the cell API
      When the container GETs that upload URL through the egress proxy
      Then the response status is 403
