const PublicId = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const BillingPeriod = /^\d{4}-(0[1-9]|1[0-2])$/

export type TariffBand = "offPeak" | "peak"

export interface MeterReading {
  readonly accountId: string
  readonly meterId: string
  readonly period: string
  readonly tariffBand: TariffBand
  readonly kilowattHours: number
}

export interface TariffRates {
  readonly offPeakMinorPerKwh: number
  readonly peakMinorPerKwh: number
}

export interface EnergySettlement extends MeterReading {
  readonly rateMinorPerKwh: number
  readonly amountMinor: number
}

/** Validates one complete metering command at the service boundary. */
export function validateMeterReading(reading: MeterReading): void {
  if (
    !PublicId.test(reading.accountId) ||
    !PublicId.test(reading.meterId) ||
    !BillingPeriod.test(reading.period)
  ) {
    throw new TypeError("invalid meter reading identity")
  }
  if (reading.tariffBand !== "offPeak" && reading.tariffBand !== "peak") {
    throw new TypeError("unsupported tariff band")
  }
  if (!Number.isSafeInteger(reading.kilowattHours) || reading.kilowattHours < 0) {
    throw new RangeError("kilowattHours must be a non-negative safe integer")
  }
}

/** Validates the fixed tariff rates before they enter LikeGo Config. */
export function validateTariffRates(rates: TariffRates): void {
  if (
    !Number.isSafeInteger(rates.offPeakMinorPerKwh) ||
    rates.offPeakMinorPerKwh < 0 ||
    !Number.isSafeInteger(rates.peakMinorPerKwh) ||
    rates.peakMinorPerKwh < 0
  ) {
    throw new RangeError("tariff rates must be non-negative safe integers")
  }
}

/** Settles one validated reading using integer minor currency units only. */
export function calculateSettlement(reading: MeterReading, rates: TariffRates): EnergySettlement {
  validateMeterReading(reading)
  validateTariffRates(rates)
  const rateMinorPerKwh =
    reading.tariffBand === "peak" ? rates.peakMinorPerKwh : rates.offPeakMinorPerKwh
  const amountMinor = reading.kilowattHours * rateMinorPerKwh
  if (!Number.isSafeInteger(amountMinor))
    throw new RangeError("settlement amount exceeds safe range")
  return Object.freeze({
    accountId: reading.accountId,
    meterId: reading.meterId,
    period: reading.period,
    tariffBand: reading.tariffBand,
    kilowattHours: reading.kilowattHours,
    rateMinorPerKwh,
    amountMinor
  })
}
