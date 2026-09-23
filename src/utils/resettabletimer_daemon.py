"""Customize base resettabletimer"""

from resettabletimer import ResettableTimer


class ResettableTimerDaemon(ResettableTimer):
    """Add Daemon to resettabletimer"""
    def _set(self):
        super()._set()
        self._timer.daemon = True