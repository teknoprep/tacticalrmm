import random

from django.contrib.postgres.fields import ArrayField
from django.db import models

from tacticalrmm.constants import AGENT_STATUS_ONLINE, AgentMonType

PROTOCOL_CHOICES = [
    ("https", "HTTPS"),
    ("http", "HTTP"),
    ("ssh", "SSH"),
    ("telnet", "Telnet"),
]


class NetworkDevice(models.Model):
    site = models.ForeignKey(
        "clients.Site",
        related_name="network_devices",
        on_delete=models.CASCADE,
    )
    name = models.CharField(max_length=255)
    protocol = models.CharField(
        max_length=10, choices=PROTOCOL_CHOICES, default="https"
    )
    ip_address = models.CharField(max_length=255)
    port = models.PositiveIntegerField(default=443)
    description = models.TextField(null=True, blank=True, default="")
    # ordered list of agent_id strings, highest preference first
    preferred_agents = ArrayField(
        models.CharField(max_length=255),
        default=list,
        blank=True,
    )
    created_time = models.DateTimeField(auto_now_add=True)
    modified_time = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ("name",)

    def __str__(self):
        return f"{self.name} ({self.protocol}://{self.ip_address}:{self.port})"

    @property
    def client(self):
        return self.site.client

    def resolve_agent(self):
        """Pick the agent to tunnel through:

        1. First ONLINE agent in ``preferred_agents`` (preference order).
        2. Otherwise a random online agent in the device's site (servers first,
           then workstations), broadening to the client if the site has none.
        Returns an Agent instance or None.
        """
        from agents.models import Agent

        # 1) walk preferred agents in order
        if self.preferred_agents:
            agents = {
                a.agent_id: a
                for a in Agent.objects.filter(agent_id__in=self.preferred_agents)
            }
            for agent_id in self.preferred_agents:
                agent = agents.get(agent_id)
                if agent and agent.status == AGENT_STATUS_ONLINE:
                    return agent

        # 2) fallback: random online agent, servers first
        for scope in (
            Agent.objects.filter(site=self.site),
            Agent.objects.filter(site__client=self.site.client),
        ):
            online = [a for a in scope if a.status == AGENT_STATUS_ONLINE]
            if not online:
                continue
            servers = [
                a for a in online if a.monitoring_type == AgentMonType.SERVER
            ]
            pool = servers if servers else online
            return random.choice(pool)

        return None
