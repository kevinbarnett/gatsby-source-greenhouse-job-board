const axios = require('axios')
const baseUrl = `https://boards-api.greenhouse.io/v1/boards`

const fetchJobs = (boardTokens) =>
  getJobs(boardTokens.map(boardToken =>
    axios.get(`${baseUrl}/${boardToken}/jobs/`)
  )
);

const fetchOffices = (boardTokens) =>
  getOffices(boardTokens.map(boardToken =>
    axios.get(`${baseUrl}/${boardToken}/offices/`))
  );

const fetchDepartments = (boardTokens) =>
  getDepartments(boardTokens.map(boardToken =>
    axios.get(`${baseUrl}/${boardToken}/departments/`))
  );

const getJobs = (urls) => Promise.all(urls)
  .then((response) => response.map((data) => ({
    url: data.config.url,
    jobs: data.data.jobs
  })))
  .then(data =>
    Promise.all(
      data.reduce((acc, { url, jobs }) =>
      [...acc, ...jobs.map(async job =>
        await getJob(`${url}${job.id}?questions=true`))], [])
    )
  )
  .catch(console.error);

const getJob = (url) =>
  axios
    .get(url)
    .then(response => response.data)
    .catch(console.error);

const getOffices = async (urls) => await Promise.all(urls)
  .then(response => response.map(data => data.data.offices))
  .then(offices => offices.reduce((acc, curr) => [...acc, ...curr], []))
  .catch(console.error);

const getDepartments = async (urls) => await Promise.all(urls)
  .then(response => response.map(data => data.data.departments))
  .then(departments => departments.reduce((acc, curr) => [...acc, ...curr], []))
  .catch(console.error);

module.exports = { fetchJobs, fetchOffices, fetchDepartments }
