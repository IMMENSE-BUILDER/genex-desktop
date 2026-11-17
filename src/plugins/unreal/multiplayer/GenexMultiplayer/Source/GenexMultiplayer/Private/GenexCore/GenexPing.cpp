// Port of packages/multiplayer/src/authority/ping.ts. See GenexPing.h.
#include "GenexCore/GenexPing.h"

#include <algorithm>
#include <cmath>
#include <cstdint>

GENEX_FP_STRICT_BEGIN

namespace genex::ping {

namespace {

/** A whole count of inputs out of a state's number: 0 for one that is not finite or not positive. */
double PingCount(double v) { return std::isfinite(v) && v > 0.0 ? std::floor(v) : 0.0; }

/** JavaScript's Math.max(0, v): what is no number stays none, where std::max would answer 0. */
double PingAtLeastZero(double v) { return std::isnan(v) ? v : (std::max)(0.0, v); }

}  // namespace

void Ping::Sent(int seq, double nowMs) {
  times_[seq] = nowMs;
  times_.erase(static_cast<std::int64_t>(seq) - kPingKeepInputs);
}

void Ping::State(double nowMs, double ack, double inBuf, int sentCount) {
  const double newest = (std::min)(static_cast<double>(sentCount), PingCount(ack) + PingCount(inBuf));
  double raw = clock_samples::kNoRoundTrip;
  if (newest > received_) {
    // Above 0 and at most `sentCount`, so it is a whole number an int holds.
    const auto at = times_.find(static_cast<std::int64_t>(newest));
    // A local clock that stepped back measures nothing below zero.
    if (at != times_.end()) raw = PingAtLeastZero(nowMs - at->second);
    received_ = newest;
  }
  const double taken = samples_.Take(nowMs, raw);
  if (taken >= 0.0) value_ = value_ < 0.0 ? taken : value_ + (taken - value_) * kPingWeight;
}

void Ping::Reset() {
  times_.clear();
  samples_ = clock_samples::ClockSamples();
  received_ = 0.0;
  value_ = kNoPing;
}

}  // namespace genex::ping

GENEX_FP_STRICT_END
