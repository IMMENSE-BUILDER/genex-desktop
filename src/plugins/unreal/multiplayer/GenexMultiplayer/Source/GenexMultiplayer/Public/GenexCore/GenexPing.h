// The link's round trip, for a game to show (PROTOCOL.md §17.3 *Ping*). The session's round trip
// (AuthoritySession::Rtt) is that of an input to the state that acknowledges it, and a paced room (§17.11
// *Input pacing*) holds a seat's inputs in a buffer before it steps them: that wait is in the round trip (the
// clock and a predicted hit's wait need it there), and it is no part of the link. A state also says how many
// of the seat's inputs the room has RECEIVED: the acknowledged one plus the ones it holds (`inBuf`). The ping
// is the time since the newest of those was sent, paced and smoothed as the clock's round trip is.
//
// Port of packages/multiplayer/src/authority/ping.ts (`createPing`), in the TypeScript's order, unfused, every
// number a double; held to packages/netcode-bench/conformance/authority/ping.json by genex_ping_check. Pure:
// no clock of its own, no core.
#pragma once

#include "GenexCore/GenexClockSamples.h"
#include "GenexCore/GenexConfig.h"

#include <cstdint>
#include <map>

namespace genex::ping {

/** How much of a new sample the ping takes: the clock's weight, at the clock's one sample per kClockSampleMs. */
inline constexpr double kPingWeight = 0.1;
/** How many inputs' send times are kept: at 120 inputs a second, two seconds. */
inline constexpr int kPingKeepInputs = 256;
/** What Ms() reads until the first sample. */
inline constexpr double kNoPing = -1.0;

/** The link's round trip to the room, measured from this seat's inputs. A fresh one reads kNoPing until a
 *  state acknowledges, or holds, an input whose send time is known. */
class GENEX_CORE_API Ping {
 public:
  /** Input `seq` (the handle's count, from 1) went out at `nowMs`, on any steady clock. */
  void Sent(int seq, double nowMs);
  /** A state arrived at `nowMs`: its acknowledged input `ack`, the seat's `inBuf` in it and how many inputs
   *  the handle has sent. `ack` and `inBuf` are whole counts of at least 0: one that is no number, not finite
   *  or not positive counts as 0 (an absent `inBuf`: none held), a fraction as the whole below it. */
  void State(double nowMs, double ack, double inBuf, int sentCount);
  /** The smoothed round trip, ms; kNoPing until the first sample. */
  double Ms() const { return value_; }
  /** A new socket: its inputs count from 1 again. */
  void Reset();

 private:
  /** When each of the last kPingKeepInputs inputs went out, by sequence number. */
  std::map<std::int64_t, double> times_;
  /** A pacer of its own, the clock's rule: one sample per kClockSampleMs. */
  clock_samples::ClockSamples samples_;
  /** The newest input a state has shown the room to have received. */
  double received_ = 0.0;
  double value_ = kNoPing;
};

}  // namespace genex::ping
