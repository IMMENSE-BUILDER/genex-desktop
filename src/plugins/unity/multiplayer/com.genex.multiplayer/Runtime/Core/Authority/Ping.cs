// The link's round trip, for a game to show (PROTOCOL.md §17.3 *Ping*), a port of
// packages/multiplayer/src/authority/ping.ts. The session's Rtt is the round trip of an input to the state that
// acknowledges it, and a paced room (§17.11 *Input pacing*) holds a seat's inputs in a buffer before it steps them: that
// wait is in Rtt (the clock and a predicted hit's wait need it there), and it is no part of the link. A state also says
// how many of the seat's inputs the room has RECEIVED: the acknowledged one plus the ones it holds (inBuf). The ping is
// the time since the newest of those was sent, paced and smoothed as the clock's round trip is.
//
// Held to the shared vectors (packages/netcode-bench/conformance/authority/ping.json) by Tests~/GenexSmoke `ping`, bit
// for bit. Engine-agnostic: no UnityEngine.
using System;
using System.Collections.Generic;

namespace Genex.Multiplayer.Authority
{
    /// <summary>The link's round trip to the room, measured from this seat's inputs (ping.ts <c>createPing</c>).</summary>
    public sealed class GenexPing
    {
        /// <summary>How much of a new sample the ping takes: the clock's weight, at the clock's one sample per
        /// <see cref="GenexClockSamples.SampleMs"/>.</summary>
        public const double Weight = 0.1;
        /// <summary>How many inputs' send times are kept: at 120 inputs a second, two seconds.</summary>
        public const int KeepInputs = 256;

        private readonly Dictionary<int, double> times = new Dictionary<int, double>();
        /// <summary>A pacer of its own: the clock's takes a round trip from other states than the ping's.</summary>
        private GenexClockSamples samples = new GenexClockSamples();
        /// <summary>The newest input a state has shown the room to have received.</summary>
        private int received;
        private double value = -1;

        /// <summary>The smoothed round trip, ms; -1 until the first sample.</summary>
        public double Ms => value;

        /// <summary>A whole count of inputs out of a state's number: 0 for one that is not finite or not positive.</summary>
        private static double Count(double v) => !double.IsNaN(v) && !double.IsInfinity(v) && v > 0 ? Math.Floor(v) : 0;

        /// <summary>Input <paramref name="seq"/> (the handle's count, from 1) went out at <paramref name="nowMs"/>, on any
        /// steady clock.</summary>
        public void Sent(int seq, double nowMs)
        {
            times[seq] = nowMs;
            times.Remove(seq - KeepInputs);
        }

        /// <summary>A state arrived at <paramref name="nowMs"/>: its acknowledged input <paramref name="ack"/>, the seat's
        /// <c>inBuf</c> in it (absent: no number) and how many inputs the handle has sent.</summary>
        public void State(double nowMs, double ack, double inBuf, int sentCount)
        {
            // Compared as doubles, so a huge ack or inBuf stops at what was sent without overflowing.
            var newest = Math.Min(sentCount, Count(ack) + Count(inBuf));
            double raw = -1;
            if (newest > received)
            {
                received = (int)newest;
                // A local clock that stepped back measures nothing below zero.
                if (times.TryGetValue(received, out var at)) raw = Math.Max(0, nowMs - at);
            }
            var taken = samples.Take(nowMs, raw);
            if (taken >= 0) value = value < 0 ? taken : value + (taken - value) * Weight;
        }

        /// <summary>A new socket: its inputs count from 1 again.</summary>
        public void Reset()
        {
            times.Clear();
            samples = new GenexClockSamples();
            received = 0;
            value = -1;
        }
    }
}
