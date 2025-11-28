const baseUrl = `https://boards-api.greenhouse.io/v1/boards`

// Helper function to handle fetch requests with proper error handling
async function fetchJSON(url) {
  const response = await fetch(url)

  if (!response.ok) {
    throw new Error(`HTTP error! Status: ${response.status}`)
  }

  return response.json()
}

async function fetchJobs(boardToken) {
  const url = `${baseUrl}/${boardToken}/jobs/`
  const jobs = await getJobs(url)
  return jobs
}

async function fetchOffices(boardToken) {
  const url = `${baseUrl}/${boardToken}/offices/`
  const offices = await getOffices(url)
  return offices
}

async function fetchDepartments(boardToken) {
  const url = `${baseUrl}/${boardToken}/departments/`
  const departments = await getDepartments(url)
  return departments
}

const getJobs = async (url) => {
  try {
    const data = await fetchJSON(url)
    const jobs = data.jobs || []

    return Promise.all(
      jobs.map(async job => {
        const jobData = await getJob(`${url}${job.id}?questions=true`)
        return jobData
      })
    )
  } catch (error) {
    throw new Error(
      `Failed to fetch jobs from Greenhouse API: ${error.message}`
    )
  }
}

const getJob = async (url) => {
  try {
    const data = await fetchJSON(url)
    return data
  } catch (error) {
    throw new Error(
      `Failed to fetch job details from Greenhouse API: ${error.message}`
    )
  }
}

const getOffices = async (url) => {
  try {
    const data = await fetchJSON(url)
    return data.offices || []
  } catch (error) {
    throw new Error(
      `Failed to fetch offices from Greenhouse API: ${error.message}`
    )
  }
}

const getDepartments = async (url) => {
  try {
    const data = await fetchJSON(url)
    return data.departments || []
  } catch (error) {
    throw new Error(
      `Failed to fetch departments from Greenhouse API: ${error.message}`
    )
  }
}

module.exports = { fetchJobs, fetchOffices, fetchDepartments }

