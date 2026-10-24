// Fields that every board has, declared so that queries work even when a board has no jobs,
// or no job uses a field yet. Everything else, like the numeric ids and job metadata, is still
// inferred from the data, since its type differs between boards.
exports.typeDefs = `
  type GreenhouseJob implements Node {
    title: String
    absolute_url: String
    content: String
    language: String
    company_name: String
    updated_at: Date @dateformat
    first_published: Date @dateformat
    location: GreenhouseJobLocation
    questions: [GreenhouseJobQuestions]
    departments: [GreenhouseDepartment] @link(from: "departments___NODE")
    offices: [GreenhouseOffice] @link(from: "offices___NODE")
  }

  type GreenhouseJobLocation {
    name: String
  }

  type GreenhouseJobQuestions {
    required: Boolean
    label: String
    description: String
    fields: [GreenhouseJobQuestionsFields]
  }

  type GreenhouseJobQuestionsFields {
    name: String
    type: String
  }

  type GreenhouseDepartment implements Node {
    name: String
    jobs: [GreenhouseJob] @link(from: "jobs___NODE")
  }

  type GreenhouseOffice implements Node {
    name: String
    location: String
    departments: [GreenhouseDepartment] @link(from: "departments___NODE")
    jobs: [GreenhouseJob] @link(from: "jobs___NODE")
  }
`
