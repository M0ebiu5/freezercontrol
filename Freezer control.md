Implement an node-red flow which controls multiple freezers. The goal is to optimize the power consumption and operation of the appliances.

## Input

Each freezer has a temperature sensor inside which reports via mqtt.

## Output

Each freezer is connected to a power outlet which can be switched via mqtt.

## Operation

Each freezer should have a maximum temperature which he should not exceed. The freezers internal temperature controler is set to minimum and can reach about -25 °C.
The optimization should consider the available pv power and power price. Also a weather forecast is available. Also the power consumption of each freezer is recorded in an influx database. Analyze the data to get the characteristic curve of each device.

## Notes

Use the appliance control project as template for project handling, procedure, mqtt and influxdb access. Handle this project via github.

Make a global object where you predict the freezer temperature, state and reason for each freezer.

The handling of the freezer should be failsafe. This means if no message from the flow arrives, the freezers turn on automatically after a certain time. This can be achieved in tasmota with this turn off message: {"topic": "tm/cmnd/OgSpGfr/event", "payload": "poweroff"} . For the homematic outlet use this message to turn off:  {"topic": "hm/set/KuehltruheAus/PRESS\_SHORT", "payload": 1}. This messages turn the freezer of for a certain time. If another message arrives during that period, it stays off - if not it turns back on.

The minimal "on" duration should be 2 slots. Only use strings in payloads when necessary.

