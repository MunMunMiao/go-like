import type { Schedule } from "@go-like/core/job"

import { newCronerSchedule, type CronerScheduleOptions } from "../src/job/index"

const options: CronerScheduleOptions = { timezone: "UTC", utcOffset: 0 }
const schedule: Schedule = newCronerSchedule("0 0 * * *", options)
const due: number | null = schedule.next(0)

void [schedule.string(), due]

// @ts-expect-error Runtime Croner options are not part of the timetable.
newCronerSchedule("* * * * * *", { paused: true })
