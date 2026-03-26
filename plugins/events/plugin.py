"""Events plugin — threshold monitoring via event_generator.

Wraps event_generator into the plugin system. The event generator monitors
collectd metrics and Home Assistant states, firing fantasy-themed alert events
when thresholds are crossed (CPU, memory, disk, temp, load, HA state changes).
"""

import event_generator


def setup(ctx):
    """Plugin setup — start event generator with raw push_event passthrough."""

    # event_generator.start_event_generator(callback) expects callback to accept
    # a complete event dict ({type, node, text, color, ...}).
    # ctx._push_event(event_dict) does exactly this — passes the dict through
    # directly. ctx.push_event(event_type, data) would double-wrap the type.
    event_generator.start_event_generator(ctx._push_event)

    ctx.log("Sentinel Wards active — threshold monitoring started (interval=%ds)",
            event_generator.CHECK_INTERVAL)
