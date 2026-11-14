@pbi-171
Feature: Migrate seeds the Keycloak test owner and resolves the issuer under floating ports
  Step 5 of the control plane redesign (2026-11-07 design, §08 and §12) signs people in locally through the
  Keycloak realm that `aspire run` starts. Each user is known by an issuer and a subject. So that someone can
  sign in as an owner before anyone has signed in, migrate run locally seeds the realm's test owner as an
  owner. It uses the subject the realm import gives that user and the realm's issuer. The Keycloak owner sits
  beside today's FACTORY_DEV_LOGIN owner, which stays until step 9. The Keycloak owner has no GitHub login.
  The issuer URL holds Keycloak's port. Normally that port is pinned to 7430, so the issuer is the realm on
  port 7430. Under FACTORY_FLOAT_PORTS=1 Aspire may pick another port, so migrate asks the running Keycloak
  for its issuer.
  Scenarios tagged @db need Postgres, which each test starts for itself. Scenarios tagged @local need Docker,
  the Aspire CLI and the owner's secrets, so the owner runs them and the PR records the run.

  Rule: Migrate run locally seeds the realm's test owner as an owner known by the realm's issuer and subject

    @ac-1 @db
    Scenario: Migrate seeds the realm's test owner beside the dev login owner
      Given no Keycloak is answering
      When migrate runs locally with the dev login "octo" and pinned ports
      Then it exits 0
      And the realm's test owner is an owner from the issuer "http://localhost:7430/realms/factory"
      And the realm's test owner has the subject the realm import gives it, and no provider
      And the realm's test owner has no GitHub login
      And the dev login "octo" is still an owner and a product owner

    @ac-1 @db
    Scenario: Migrate seeds the realm's test owner when no dev login is set
      Given no Keycloak is answering
      When migrate runs locally with no dev login and pinned ports
      Then it exits 0
      And the realm's test owner is an owner from the issuer "http://localhost:7430/realms/factory"

    @ac-1 @db
    Scenario: Running migrate again leaves one Keycloak test owner
      Given migrate has run locally with the dev login "octo" and pinned ports
      When migrate runs locally with the dev login "octo" and pinned ports
      Then it exits 0
      And exactly one user from the issuer "http://localhost:7430/realms/factory" exists
      And the realm's test owner is an owner from the issuer "http://localhost:7430/realms/factory"

    @ac-1 @db
    Scenario: Migrate makes the test owner an owner again after someone demoted it
      Given the realm's test owner from the issuer "http://localhost:7430/realms/factory" is a viewer
      When migrate runs locally with the dev login "octo" and pinned ports
      Then it exits 0
      And exactly one user from the issuer "http://localhost:7430/realms/factory" exists
      And the realm's test owner is an owner from the issuer "http://localhost:7430/realms/factory"

    @ac-1 @db @regression
    Scenario: Migrate still seeds the dev login as an owner and a product owner
      When migrate runs locally with the dev login "octo" and pinned ports
      Then it exits 0
      And the dev login "octo" is still an owner and a product owner

  Rule: Under floating ports, migrate asks the running Keycloak for the realm's issuer

    @ac-2 @db
    Scenario: Migrate keys the test owner on the issuer Keycloak names on the port Aspire picked
      Given Keycloak answers on a port other than 7430, and its realm names its issuer on that port
      When migrate runs locally with the dev login "octo" and floating ports
      Then it exits 0
      And the realm's test owner is an owner from the issuer Keycloak named
      And no user from the issuer "http://localhost:7430/realms/factory" exists
      And the dev login "octo" is still an owner and a product owner

    @ac-2 @db
    Scenario: Under floating ports, migrate fails rather than guess the issuer when Keycloak doesn't answer
      Given no Keycloak is answering
      When migrate runs locally with the dev login "octo" and floating ports
      Then it exits with an error naming Keycloak
      And no user from the issuer "http://localhost:7430/realms/factory" exists

    @ac-2 @local
    Scenario: Under aspire run with floating ports, migrate seeds the test owner on the live realm's issuer
      Given "aspire run" is up with FACTORY_FLOAT_PORTS=1
      When I read the issuer from the live realm's OpenID discovery document
      Then the database holds the realm's test owner as an owner from that issuer
      And the e2e client's token for the test owner carries that issuer and the test owner's subject
