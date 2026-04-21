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
