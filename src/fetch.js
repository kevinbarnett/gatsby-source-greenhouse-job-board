const axios = require('axios')
const baseUrl = `https://boards-api.greenhouse.io/v1/boards`

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

const getJobs = (url) => 
  axios
    .get(url)
    .then(response => response.data.jobs)
    .then(jobs => {
      return Promise.all(
        jobs.map(async job => {
          const node = await getJob(`${url}${job.id}?questions=true`)
          return node
        })
      )
    })
    .catch(error => console.log(error))

const getJob = (url) => 
  axios
    .get(url)
    .then(response => response.data)
    .then(data => {
      return data
    })
    .catch(error => console.log(error))

const getOffices = (url) => 
  axios
    .get(url)
    .then(response => response.data.offices)
    .then(offices => {
      return offices
    })
    .catch(error => console.log(error))

const getDepartments = (url) => 
  axios
    .get(url)
    .then(response => response.data.departments)
    .then(departments => {
      return departments
    })
    .catch(error => console.log(error))

module.exports = { fetchJobs, fetchOffices, fetchDepartments }

