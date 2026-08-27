import http from "k6/http"
import { check } from "k6"

export const options = {
  scenarios: {
    steady: {
      executor: "constant-arrival-rate",
      duration: __ENV.GO_LIKE_SOAK_DURATION,
      rate: Number(__ENV.GO_LIKE_SOAK_RATE || "20"),
      timeUnit: "1s",
      preAllocatedVUs: 32,
      maxVUs: 32
    }
  },
  summaryTrendStats: ["avg", "min", "med", "max", "p(90)", "p(95)", "p(99)"],
  thresholds: {
    checks: ["rate==1"],
    dropped_iterations: ["count==0"],
    http_req_failed: ["rate==0"]
  }
}

export default function requestGoLike() {
  const response = http.get(__ENV.GO_LIKE_SOAK_URL)
  check(response, {
    "status is 200": (value) => value.status === 200,
    "body is go-like": (value) => value.body === "go-like"
  })
}
