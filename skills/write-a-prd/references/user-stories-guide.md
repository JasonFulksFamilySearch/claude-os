# User Stories and Acceptance Criteria Guide

## Standard Format

User stories follow this structure:

```
As a [user type], I want [goal], so that [benefit]
```

**Good example:**
```
As a project manager, I want to see a burndown chart for my sprint,
so that I can track progress toward the sprint goal
```

## INVEST Criteria

Each user story should meet the INVEST criteria:

- **Independent:** The story can be completed without depending on other stories
- **Negotiable:** Details are open to discussion; scope is flexible within the goal
- **Valuable:** It delivers value to the user or the business
- **Estimable:** The team can estimate the effort required
- **Small:** It can be completed within a single sprint or iteration (ideally 1–5 days)
- **Testable:** Success can be verified with acceptance criteria

## Acceptance Criteria (Gherkin Format)

Each user story should include acceptance criteria in Given/When/Then format:

```
Given [context or precondition]
When [action taken]
Then [expected outcome]
```

**Example:**

```
Feature: View account balance

Scenario: Balance displays for authenticated user
  Given I am logged in to my bank account
  When I navigate to the account dashboard
  Then I should see my current account balance
  And the balance should be accurate as of the last transaction

Scenario: Balance updates after deposit
  Given I have an existing account with a $100 balance
  When a $50 deposit posts to the account
  Then the balance should display $150
  And the transaction history should show the deposit
```

## Definition of Ready (Before Sprint)

A user story is ready for development when:

- [ ] The story meets all INVEST criteria
- [ ] Acceptance criteria are written in Gherkin format
- [ ] Dependent stories are clearly documented
- [ ] The team has estimated the effort
- [ ] Business stakeholders agree on the goal

## Definition of Done (After Development)

A story is complete when:

- [ ] All acceptance criteria pass (Gherkin scenarios execute successfully)
- [ ] Code review is approved
- [ ] Test coverage meets team standards
- [ ] Documentation is updated if needed
- [ ] The change is deployed to the target environment
